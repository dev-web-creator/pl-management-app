# 運用マニュアル（日常のオーナー作業）

コードを触らずに、Vercel の設定だけで完結する日常運用のまとめ。
（デプロイの仕組みは `deploy-vercel.md`、AWS版の起動/停止は `aws-deployment.md` 6.5 を参照）

---

## 1. 友達を招待する（3分・コード変更不要）

1. [Vercel](https://vercel.com) → `pl-management-app` → **Settings → Environment Variables**
2. 一覧から **`AUTH_ALLOWED_EMAILS`** の右の「…」→ **Edit**
3. **Value を編集**して、カンマ区切りでメールアドレスを追記 → Save

   ```
   最初：        friend1@gmail.com
   2人目を追加：  friend1@gmail.com,friend2@gmail.com
   3人目を追加：  friend1@gmail.com,friend2@gmail.com,friend3@gmail.com
   ```

   > ⚠️ **「Add Another」ボタンは使わない**（あれは別の環境変数＝新しいKey-Valueの行を
   > 増やすボタン。同名の変数は2つ作れない）。**変数は1個だけ、値の中がメールの名簿**。
   > スペースが混ざってもアプリ側で除去するので気にしなくてよい。

4. **Deployments タブ → 最新デプロイの「…」→ Redeploy**（環境変数はRedeployするまで反映されない。忘れがちなので注意）
5. 友達にURL（https://pl-management-app.vercel.app）を送る

友達がGoogleでログインした瞬間に、**専用の家計簿（初期カテゴリ16種・ウォレット3種つき、
オーナーのデータとは完全分離）が自動作成**される（ADR-037のプロビジョニング）。

## 2. アクセスを取り消す

- **ゆるやかに**：`AUTH_ALLOWED_EMAILS` から該当メールを削除 → Redeploy。
  新規ログインは即ブロック。ただし本人が既にログイン中ならセッション（最長30日）が切れるまで使える。
- **即時に締め出す**：上に加えて **`AUTH_SECRET` を新しいランダム値に変更** → Redeploy。
  全員のセッションが無効になり強制ログアウト（名簿に居る人は再ログインすればOK）。
  新しい値の作り方：PowerShellで `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

※ 取り消してもその人のデータ（user行・取引）はDBに残る。完全削除したい場合はDB操作が必要（Claudeに依頼）。

## 3. 環境変数の一覧（これが最小構成・消してはいけない）

| 変数 | 役割 |
|---|---|
| `DATABASE_URL` | 本番DB（Neon）への接続文字列 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Googleログイン（Google Cloud Console `pl-ledger` プロジェクトで発行） |
| `AUTH_SECRET` | セッションCookieの署名鍵。変えると全員ログアウト |
| `AUTH_OWNER_EMAIL` | オーナーのGmail。このメールでのログイン＝user 1（実データ）に入る |
| `AUTH_ALLOWED_EMAILS` | 招待名簿（カンマ区切り・任意） |

## 4. よくある操作

- **コードの修正を本番に出す**：GitHubへpushするだけ（Vercelが自動デプロイ・約30秒）
- **AWS版で遊ぶ**：`docs/aws-deployment.md` 6.5 の起動コマンド（普段は停止＝ストレージ代のみ）
- **DBの中身を直接見る**：ログインした状態で `/inspect`（読み取り専用）
- **調子がおかしい時の一次切り分け**：`/api/health` を開く（`{"ok":true,...}` が出ればアプリ⇔DBは正常）
