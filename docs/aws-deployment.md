# AWS デプロイ手順書（Phase 5）

> ⚠️ **重要（実行前に必ず読む）**
> このドキュメントの手順は **AWSアカウント・認証情報が必要** で、**実際のリソース作成は課金が発生**します。
> Claude はユーザーの明示的な許可なく課金リソースの作成は行いません。
> 下記は「準備済みの設計＋すぐ実行できるコマンド集」です。実際の構築は、あなたが
> AWSアカウントと credentials を用意し、明示的にGoを出してから一緒に進めます。
> （無料利用枠：RDS db.t4g.micro は新規アカウントで12か月無料の対象になり得ます）

---

## 1. ターゲット構成（推奨）

学習しやすさ・運用の軽さ・コストのバランスで以下を推奨します。

```
[ユーザー(ブラウザ/モバイル)]
        │ HTTPS（App Runnerが自動でTLS付与）
        ▼
[AWS App Runner] ── コンテナ(本リポジトリのDockerfile)を ECR から起動・オートスケール
        │ VPCコネクタ（プライベート接続）
        ▼
[Amazon RDS for PostgreSQL]（プライベートサブネット・パブリック非公開）
        ▲
[AWS Secrets Manager] ── DATABASE_URL / DBパスワードを保管（コードに埋めない）
[Amazon ECR] ── コンテナイメージの置き場
```

**なぜこの構成か**
- **App Runner**: コンテナURLを渡すだけでHTTPS・オートスケール・デプロイを面倒見てくれる。ECS/Fargateより学習コストが低い。
- **RDS PostgreSQL**: ローカルと同じPostgreSQL。`db/schema.sql`/`seed.sql` がそのまま使える（ADR-005の「ローカル先行→AWS」が活きる）。
- **Secrets Manager**: 接続情報をイメージや環境変数直書きにしない（セキュリティ）。

代替案: 速さ最優先なら **Aurora Serverless v2**（自動スケール、停止時コスト低）、あるいは **Amplify Hosting**（ただしNext.jsのサーバー機能は App Runner の方が素直）。

---

## 2. 事前準備（ローカル）

```powershell
# AWS CLI と Docker Desktop が必要
aws --version
docker --version
aws configure   # アクセスキー / リージョン(例: ap-northeast-1) を設定
```

本番ビルドが通ることは確認済み（`npm run build` → `output: standalone`）。
コンテナは本リポジトリの `Dockerfile` でビルドする。

---

## 3. 手順（コマンド集 / リージョンは ap-northeast-1 想定）

### 3-1. ECR にイメージを push
```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-northeast-1
aws ecr create-repository --repository-name pl-app
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build -t pl-app .
docker tag pl-app:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/pl-app:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/pl-app:latest
```

### 3-2. RDS PostgreSQL を作成（最小構成）
```bash
# パスワードは Secrets Manager に入れる前提。ここでは一時的に変数で扱う
aws rds create-db-instance \
  --db-instance-identifier pl-app-db \
  --engine postgres --engine-version 16 \
  --db-instance-class db.t4g.micro \
  --allocated-storage 20 \
  --master-username plapp \
  --master-user-password "<STRONG_PASSWORD>" \
  --db-name pl_app \
  --no-publicly-accessible \
  --backup-retention-period 7
# 起動完了まで数分。エンドポイント取得:
aws rds describe-db-instances --db-instance-identifier pl-app-db \
  --query 'DBInstances[0].Endpoint.Address' --output text
```

### 3-3. スキーマ＆初期データ投入（RDSへ）
RDSはプライベートなので、以下のいずれかで到達して流す：
- 同VPC内の踏み台(EC2)や CloudShell/SSM 経由で `psql`、または一時的に許可したセキュリティグループから。
```bash
export PGPASSWORD='<STRONG_PASSWORD>'
psql -h <RDS_ENDPOINT> -U plapp -d pl_app -v ON_ERROR_STOP=1 -f db/schema.sql
psql -h <RDS_ENDPOINT> -U plapp -d pl_app -v ON_ERROR_STOP=1 -f db/seed.sql
# 確認
psql -h <RDS_ENDPOINT> -U plapp -d pl_app -c "\dt"
```
> 本番では SSL 必須。接続文字列に `?sslmode=require` を付ける（下記）。

### 3-4. 接続情報を Secrets Manager に保存
```bash
aws secretsmanager create-secret --name pl-app/DATABASE_URL \
  --secret-string "postgresql://plapp:<STRONG_PASSWORD>@<RDS_ENDPOINT>:5432/pl_app?sslmode=require"
```

### 3-5. App Runner サービス作成
- ソース: ECR の `pl-app:latest`
- ポート: `3000`
- 環境変数: `DATABASE_URL` を **Secrets Manager 参照**で注入
- **認証系 env（ADR-037）も忘れずに**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `AUTH_SECRET` /
  `AUTH_OWNER_EMAIL`（＋招待用 `AUTH_ALLOWED_EMAILS`）。秘密系は Secrets Manager 参照を推奨。
  Google Cloud Console の承認済みリダイレクトURIに `https://<App RunnerのURL>/api/auth/google/callback` を追加すること。
- **VPCコネクタ**: RDS のあるプライベートサブネットに接続（App Runner → RDS 到達のため）
- RDS のセキュリティグループで、App Runner VPCコネクタの SG から 5432 を許可
- ヘルスチェック: `/api/health`（DB接続込みで200を返す）

（CLIは引数が多いので、初回はマネジメントコンソールのウィザードが分かりやすい。確定後にCLI/IaC化する。）

---

## 4. コスト目安（東京リージョン・概算/月）

| リソース | 構成 | 概算 |
|----------|------|------|
| RDS PostgreSQL | db.t4g.micro + 20GB | 約 $13〜16（新規は12か月無料枠あり） |
| App Runner | 最小・低トラフィック | 約 $5〜25（アイドル時間で変動） |
| ECR | イメージ数百MB | ほぼ $0〜1 |
| Secrets Manager | 1シークレット | 約 $0.4 |
| **合計** | | **約 $20〜45/月**（無料枠次第でさらに低く） |

> 個人利用なら、使わない期間は App Runner を一時停止 / RDS を停止してコストを抑えられる。

---

## 5. セキュリティ方針（最初から守る）

- **接続情報は Secrets Manager**。イメージ・Git・環境変数直書きにしない（`.env.local` は `.gitignore` 済み）。
- **RDS は publicly-accessible=false**。インターネットから直接叩けないようにする。
- **通信は TLS**（`sslmode=require`）。
- **最小権限**のIAMロール（App Runner には ECR pull と Secrets 読み取りのみ）。
- DBの自動バックアップ（保持7日）を有効化済み。

---

## 6. 将来のIaC化（任意）

手順が固まったら Terraform / AWS CDK でコード化し、`infra/` に置く。
「クリックで作った構成」を再現可能にし、環境複製・削除を安全にする（ADR候補）。

---

## 6.4 構築済みリソース（2026-07-06 稼働確認済み）

| リソース | 値 |
|---|---|
| AWS版URL | https://mnuwnhxg9c.ap-northeast-1.awsapprunner.com |
| App Runner SERVICE_ARN | `arn:aws:apprunner:ap-northeast-1:616532575651:service/pl-app/d7c2728a7a994d84ac1e3d8b53ac918b` |
| RDS | `pl-app-db`（db.t4g.micro / pl-app-db.c5qc4soaeqy9.ap-northeast-1.rds.amazonaws.com） |
| ECR | `616532575651.dkr.ecr.ap-northeast-1.amazonaws.com/pl-app` |
| CodeBuild | `pl-app-build`（S3: pl-app-build-616532575651/src.zip がソース） |
| Secrets Manager | `pl-app/DATABASE_URL` |
| 予算アラート | $20/月（50%・80%・超過見込みでメール） |

**ハマりどころの記録（実際に踏んだ）**:
1. **新無料プランでは App Runner が使えない** → 従量課金プランへのアップグレードが必要（SubscriptionRequiredException）。
2. **node-postgres は RDS の証明書を検証できない**（Amazon独自CA）→ 接続文字列は `sslmode=no-verify`
   （暗号化は有効・CA検証のみスキップ。厳密にやるなら RDS CAバンドルをイメージに同梱して `sslmode=verify-full`）。
3. **App Runner は実行時に `HOSTNAME` 環境変数をコンテナ名で上書きする** → Next.js standalone が 0.0.0.0 に
   バインドせずヘルスチェック不通に。Dockerfile の CMD を `sh -c "HOSTNAME=0.0.0.0 node server.js"` にして解決。
4. DBのSGは 5432 を 0.0.0.0/0 開放（App Runner のデフォルト egress は固定IPが無いため）。強パスワード＋TLS＋
   通常時DB停止で緩和。厳密化するなら VPCコネクタ＋NAT（+$32/月）構成へ。

## 6.5 日常運用：デフォルト停止（学習時だけ起動）

AWS版は学習用環境なので、**普段は止めてストレージ代（$2〜3/月）だけ**にする。
本番は Vercel + Neon が動き続けているため、止めてもアプリ利用に影響なし。

```powershell
# 学習を始めるとき（RDS起動に3〜5分かかる）
aws rds start-db-instance --db-instance-identifier pl-app-db
aws apprunner resume-service --service-arn <SERVICE_ARN>
aws apprunner start-deployment --service-arn <SERVICE_ARN>  # 停止中に貯まった最新イメージを反映

# 学習を終えるとき
aws apprunner pause-service --service-arn <SERVICE_ARN>
aws rds stop-db-instance --db-instance-identifier pl-app-db
```

> ✅ **自動化済み（2026-07-06）**：Lambda `pl-app-stop-rds`（`infra/lambda/stop_rds.py`）が
> EventBridge ルール `pl-app-nightly-stop`（毎日 05:00 JST）で RDS を停止する。
> 止め忘れも「停止7日後の自動再起動」も翌朝に自動で止め直される。
> 学習中に夜をまたぐ場合は翌朝また `start-db-instance` すればよい。

## 6.6 コード更新のAWS反映（自動化済み）

✅ **自動化済み（GitHub Actions・2026-07-06）**: master へ push すると
`.github/workflows/deploy-aws.yml` が S3→CodeBuild→App Runner を自動実行する
（認証はOIDC・GitHubにAWSキーを保存しない。IAMロール: `pl-app-github-actions`）。
App Runner が停止中のときはイメージ更新のみ行い、次回の resume + start-deployment で最新が反映される。
以下は手動で行う場合のコマンド（参考）：

```powershell
# 1. ソースをzip化してS3へ → 2. CodeBuildでイメージ再ビルド → 3. App Runnerへ再デプロイ
git archive --format=zip -o src.zip HEAD
aws s3 cp src.zip s3://pl-app-build-616532575651/src.zip
aws codebuild start-build --project-name pl-app-build   # 完了までみておく
aws apprunner start-deployment --service-arn <SERVICE_ARN>
```


## 7. 実行ゲート（チェックリスト）

実際の構築を始める前に、以下をユーザーが用意・承認していること：
- [ ] AWSアカウントと `aws configure` 済みの credentials
- [ ] 課金が発生することへの明示的な同意（概算 $20〜45/月）
- [ ] リージョン（既定 ap-northeast-1 で良いか）
- [ ] Docker Desktop が起動できる環境
