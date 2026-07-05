# ロードマップ / TODO（できている・いないの棚卸し）

> 現状の単一の真実(source of truth)。完了で✅、着手中で🚧、未着手で⬜。
> 優先度：**P1=実データ投入前に必要 / P2=運用の幅を広げる / P3=発展**。
> 根拠はADR（`docs/decisions.md`）。本番は Vercel + Neon で稼働中。

## ✅ できていること（実装済み）
- ✅ DB：スキーマ13テーブル＋初期データ（ローカル `pl_app` / 本番 Neon 両方）
- ✅ ダッシュボード（`/`）：**月切替**（`?m=`＋‹›）、PLサマリ（可処分所得→固定費→変動費→月次黒字）、
  資産サマリ（総資産／カード未払い／純資産）、**固定費の予実**（予定=マスタ／実額=取引・ADR-030）、
  変動費の階層ロールアップ、ウォレット残高（全部SQL集計・残高カラム無し）
- ✅ 取引入力（`AddTransactionForm`＋`POST /api/transactions`）：支出/収入の**単一脚**、脚合計の検証、原子的INSERT
- ✅ DBインスペクター（`/inspect`）：全テーブル閲覧（学習用）
- ✅ 本番デプロイ：GitHub(private)→Vercel→Neon。PC/スマホから利用可
- ✅ ドキュメント：要件/マスタ/ER設計/how-it-works/ADR-001〜031/デプロイ手順（Vercel+Neon）

## 🚧 着手中・直近の宿題
- 🚧 **サイト保護**（ADR-029）：Basic認証を入れたが Vercel で全ルート500 → 一旦撤去。**安全な方式で再導入が必要**（/inspect は認証の内側で残す方針）。
- 🚧 固定費の予実（ADR-030）：表示は完了。各行からの**「実額で記録」ワンタップ**操作が残り。

## ⬜ バックログ（優先度順）

### P1（実データを入れる前に必要）
- ✅ **/inspect の保護**（ルート単位ガード・本番は `INSPECT_KEY`＋`?key=` 必須／ローカルは開放／全体middlewareは不使用で500回避）。
- ⬜ **サイト全体の認証**（ADR-029）：ダッシュボード等もまだ公開。Vercel Previewで検証した安定middlewareで。実データ投入前に。
- ✅ **取引一覧ビュー**（`/transactions`・月切替・**削除**・**編集**）：一覧＋`DELETE`＋`PUT /api/transactions/[id]`＋`/transactions/[id]/edit`（フォーム流用）。分割払いは編集で単一脚に集約。
- ✅ 固定費「実額で記録」ワンタップ（ADR-030次段）：`POST /api/recurring/post`＋`RecordFixedCostButton`。予定行から1タップで当月の実額取引化（重複ガードあり）。
- ✅ **固定費マスタ管理UI**（`/fixed-costs`）：アプリ内で追加/編集/解約(終了年月)/削除。`/api/recurring`(POST)・`/api/recurring/[id]`(PUT/DELETE)・`RecurringForm`。→ **実値はユーザーがUIから直接入力可**（seedの🔶仮置きはUIで上書きしていく方針）。

### P2（運用の幅）
- ✅ 振替／チャージ／カード支払いのUI（`/transfers`・`POST /api/transfers`・`DELETE /api/transfers/[id]`・`AddTransferForm`）。残高に連動・PL非計上。※クレカ請求サイクル(card_statements)との厳密な消込は ADR-023 実装時に。
- ✅ クレカ請求サイクル＋カードビュー（`/cards`）：発生日＋締め日から請求サイクルを自動判定し、カード別・締め別の引落予定額と「次回引落」を表示（ADR-023）。`getCardLegs`＋アプリ側で締め/引落日を算出。脚ベースなので分割払いのカード負担分も正しく集計。
- ✅ クレカ「引き落とし実行（消込）」ワンタップ：サイクルから銀行→カードの振替(card_settlement)を1件作成し未払いを消込。memoに締めキーを埋めて二重消込を防止・「消込済み」表示（ADR-003/023）。`/api/cards/settle`・`SettleCardButton`・`getCardSettlements`。
- ✅ 分割払いの入力UI（ADR-025）：取引入力フォームに「分割払い」トグル→複数の決済手段(ウォレット+金額)を入力。内訳計＝金額の一致を検証。作成時のみ（編集は単一脚に集約）。
- ✅ 予実（`/budget`）：収入/支出/収支の目標×実績・達成率・差異、月次確定（黒塗り `monthly_closings`）。`getBudgetVsActual`・`/api/targets`・`/api/closings`・`BudgetForm`・`ConfirmMonthButton`（ADR-016/018/020）。

### P3（発展）
- ✅ 給与明細の入力（`/payslips`・`/payslips/[period]/edit`・`POST /api/payslips`[月ごとupsert]・`DELETE /api/payslips/[id]`・`PayslipForm`）。支給/控除を動的行で入力→総支給・控除合計・手取り・時給換算を自動計算。税/社保は控除で管理（支出非計上・ADR-022）。**OCRは後段**。
- ✅ 資産ダッシュボード（`/assets`）：総資産の推移（インラインSVG）・種別内訳・配当推移・**資産形成の目標達成率**（月次の総資産目標vs現在）。`getAssetTrend`/`getAssetBreakdown`/`getDividendTrend`/`getAssetTarget`。目標は予実(`/budget`)で設定。
- ✅ 残高リコンサイル（`/reconcile`）：実残高を入力→自動算出値と照合し差（記入漏れ）を表示。`balance_snapshots`にupsert（ADR-027）。
- ⬜ マルチユーザー / ログイン（今は `USER_ID=1` 固定・ADR-004）
- ✅ FY（年度）年次ビュー（`/year`）：FY開始月(設定/既定4月)から12ヶ月の月次PL＋年計＋黒字推移バー、前年度/翌年度送り・**FY比較（直近3年度）**（ADR-007/017）。
- ✅ 前月比（ダッシュボードの月次黒字に前月比・前月額を表示）
- ✅ ビジョン/目標レイヤー（`/vision`）：自由記述の箱（1ユーザー1箱・`vision_notes`テーブル新設）。まず入力できる場所を用意。将来は予実/資産目標と連動余地。
- 🚧 給与明細OCR：Gemini無料枠で実装方針（要 GEMINI_API_KEY＝Google AI Studioの無料キー）。キー入手後に実装予定。
- ✅ Phase 3 残：画面遷移図・API一覧の文書化（`docs/screens-and-api.md`）
- ✅ ダッシュボードにカテゴリ別比率グラフ（変動費グループの構成比バー＋%）を追加（要件のBIビュー項目）
- ❌ AWS版プロビジョニング：不採用（Vercel+Neonで安定稼働中のため成果物を撤去・ADR-031。必要になればgit履歴から復元可）

## 今やること（直近の順番）
1. ✅ 取引一覧＋削除（P1）
2. ✅ 固定費「実額で記録」ワンタップ（ADR-030）
3. ✅ /inspect のルート単位保護（本番キー必須）
4. サイト全体の認証（ADR-029・Previewで検証）← 次の候補
5. seed固定費の実値化 / 振替・予実 などP2へ
