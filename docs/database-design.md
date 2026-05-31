# データベース設計（基本設計）

> **状態: DRAFT（詳細）** — Phase 3。骨格は合意済み。各テーブルの全カラム定義まで記載。
> レビュー合意後に DDL（CREATE TABLE）＋seed へ。設計判断の根拠は `docs/decisions.md`（ADR）。

## エンティティ一覧（骨格）

| # | テーブル | 役割 | 主な関連（FK） | 根拠ADR |
|---|----------|------|----------------|---------|
| 1 | `users` | ユーザー＋設定（FY開始月など） | — | 004,007,017 |
| 2 | `wallets` | 口座/カード/プリペイド/ポイント/現金 | settlement_wallet_id→wallets（カードの引落先） | 002,012,015,024,025,026 |
| 3 | `categories` | 勘定科目（自己参照ツリー＋PL区分） | parent_id→categories | 008,010,013,021 |
| 4 | `transactions` | 取引1件（収入/支出）。発生主義 | category_id→categories, card_statement_id→card_statements | 001,019,023 |
| 5 | `transaction_legs` | 取引の**支払い脚**（分割支払い対応） | transaction_id→transactions, wallet_id→wallets | 025 |
| 6 | `transfers` | 資金移動（振替/チャージ/現金出し/クレカ消込） | from_wallet_id, to_wallet_id→wallets | 003,024,026 |
| 7 | `recurring_rules` | 固定費・サブスクマスタ | category_id→categories, settlement_wallet_id→wallets | 011,012,020 |
| 8 | `card_statements` | クレカ請求サイクル（締め/支払/消込） | wallet_id→wallets（カード） | 001,003,023 |
| 9 | `targets` | 予実の予算・目標（収入/支出/総資産） | — | 016,018,020,027 |
| 10 | `monthly_closings` | 月×区分の確定/未確定（黒塗り） | — | 020 |
| 11 | `payslips` | 給与明細（額面・控除・手当・労働KPI） | — | 009,022 |
| 12 | `payslip_items` | 給与明細の明細行（控除/手当/KPI） | payslip_id→payslips, category_id→categories(deduction) | 009,022 |
| 13 | `balance_snapshots` | 任意のリコンサイル（実残高） | wallet_id→wallets | 027 |

> 全テーブルに `user_id`（マルチユーザー対応 / ADR-004）。
> ビジョン/非金額KPI（読書50冊等）はMVP外（金額目標は `targets` で対応）。

## 関連（ER概要）

```
users ─┬─< wallets ──(settlement_wallet_id, 自己参照)
       │      ├──< transaction_legs >── transactions
       │      ├──< transfers (from/to)
       │      ├──< card_statements ──< transactions
       │      └──< balance_snapshots
       ├─< categories ──(parent_id, 自己参照)
       │      ├──< transactions
       │      ├──< recurring_rules
       │      └──< payslip_items
       ├─< targets            (収入/支出/総資産の月次予算・目標)
       ├─< monthly_closings   (月×区分の確定フラグ)
       └─< payslips ──< payslip_items
```

## 設計上の重要ポイント（なぜこの形か）

1. **取引と「支払い脚」を分離（transactions / transaction_legs）**
   - 取引＝「いつ・何に・いくらの費用/収入が発生したか」（カテゴリ側）。
   - 支払い脚＝「どのウォレットからいくら払ったか」（決済側）。1取引に複数脚を許し、
     **カード¥8,000＋ポイント¥2,000** の分割支払い（ADR-025）を自然に表現。
   - 通常の支出は脚1本。これでウォレット残高は「脚」を集計すれば常に正確（ADR-026）。

2. **categories は自己参照ツリー＋pl_type**
   - `変動費 > 食費 > 食費(1人) > 朝飯` の4階層を1テーブルで表現（ADR-008）。
   - `pl_type`(income/fixed_cost/variable_cost/deduction/excluded)で予実・PL集計が1クエリ（ADR-010,013,021）。

3. **card_statements が締め日問題を吸収**
   - 取引の発生日＋カードの締め日で請求サイクルを自動判定（EPOS入れ替え廃止 / ADR-023）。
   - 支払日に「銀行→カード」の transfers 1件で消込（ADR-003）。

4. **transfers が資金移動を一本化**
   - 振替・チャージ・現金出し・クレカ消込を同一テーブルで表現（ADR-024,026）。PL（損益）には載らない。

5. **予実は targets ＋ monthly_closings**
   - 月次の収入/支出/総資産の目標を `targets` に。実績は transactions/legs から集計。
   - 月が締まると `monthly_closings` で確定（黒塗り / ADR-020）。差異・達成率は算出。

6. **残高は持たず算出。リコンサイルは任意**
   - 残高＝initial_balance＋脚＋振替の集計（ADR-002,026）。
   - `balance_snapshots` に実残高を任意入力し、差分を警告（記入漏れ検知 / ADR-027）。

---

## 共通方針（型・PK・FKの考え方）

学習ポイントとして、まず全テーブル共通のルールを置く。

- **主キー（PK）**: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`。
  - PK＝その行を一意に指す「背番号」。自動採番で重複しない。
  - （本番では推測されにくい `uuid` も選択肢。学習では分かりやすい連番bigintを採用）
- **外部キー（FK）**: 他テーブルのidを指す列。例 `wallets.user_id → users.id`。
  - FK＝「この行はどの親に属すか」を強制する仕組み。存在しない親を指せない（参照整合性）。
  - 親削除時の挙動：マスタは `ON DELETE RESTRICT`（誤削除防止）、明細は `ON DELETE CASCADE`。
- **金額**: `integer`（**円単位の整数**）。日本円は小数が無いので整数が最適＝浮動小数の誤差ゼロ。
- **日付**: 発生日など暦日は `date`。記録時刻は `timestamptz`（タイムゾーン付き）。
- **年月**: 「2026年4月」は月初日 `date`（例 `2026-04-01`）で表現すると比較・集計が楽。
- **区分**: `text + CHECK制約`（例 pl_type）。将来値が増えても移行が容易。
- 全テーブルに `user_id`（マルチユーザー / ADR-004）、`created_at` / `updated_at`。

---

## 各テーブル定義

### 1. users（ユーザー＋設定）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| email | text | UNIQUE NOT NULL | ログインID |
| display_name | text | | 表示名 |
| fiscal_year_start_month | smallint | NOT NULL DEFAULT 4, CHECK(1–12) | FY開始月（可変 / ADR-017）|
| created_at / updated_at | timestamptz | DEFAULT now() | |

### 2. wallets（口座/カード/プリペイド/ポイント/現金）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| name | text | NOT NULL | 例: みずほ銀行 |
| type | text | NOT NULL CHECK('bank','credit_card','prepaid','points','cash') | 種別（ADR-026）|
| branch | text | | 支店（浜松町 等）|
| initial_balance | integer | NOT NULL DEFAULT 0 | 開始残高。現在残高の起点（ADR-002）|
| is_balance_tracked | boolean | NOT NULL DEFAULT true | 現金=false（残高は追わない / ADR-015）|
| include_in_assets | boolean | NOT NULL DEFAULT true | 資産合計に含めるか（ADR-026）|
| display_order | int | | 表示順 |
| is_active | boolean | NOT NULL DEFAULT true | |
| closing_day | smallint | NULL | 〔カード〕締め日。NULL＋eom_flagで末日 |
| closing_eom | boolean | DEFAULT false | 〔カード〕末締めか |
| payment_day | smallint | NULL | 〔カード〕支払日 |
| payment_eom | boolean | DEFAULT false | 〔カード〕末払いか |
| payment_month_offset | smallint | DEFAULT 1 | 〔カード〕締めから支払いまで（翌月=1）|
| settlement_wallet_id | bigint | FK→wallets NULL | 〔カード〕引落先口座（自己参照 / ADR-012）|

> カード専用列は type='credit_card' のときのみ使用、他はNULL。
> 例：EPOS = closing_day27 / payment_day27 / offset1、PayPay = closing_eom / payment_day27 / offset1、Olive = closing_eom / payment_day26 / offset1。

### 3. categories（勘定科目ツリー）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| parent_id | bigint | FK→categories NULL | 自己参照。ルートはNULL（ADR-008）|
| name | text | NOT NULL | 例: 朝飯 |
| pl_type | text | NOT NULL CHECK('income','fixed_cost','variable_cost','deduction','excluded') | PL区分 |
| is_input_allowed | boolean | NOT NULL DEFAULT true | 集計ノード=false（食費(1人)等は入力不可 / ADR-008）|
| display_order | int | | |
| is_active | boolean | NOT NULL DEFAULT true | |

> 取引は is_input_allowed=true の葉カテゴリにのみ紐づく。`食費合計`等の上位は集計で算出。

### 4. transactions（取引）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| category_id | bigint | FK→categories NOT NULL | 葉カテゴリ |
| type | text | NOT NULL CHECK('expense','income') | 収入/支出 |
| amount | integer | NOT NULL CHECK(>0) | **総額（満額）**（ADR-025）|
| accrual_date | date | NOT NULL | 発生日＝PL計上日（発生主義 / ADR-001）|
| is_confirmed | boolean | NOT NULL DEFAULT true | 予実の確定フラグ（概算→確定）|
| card_statement_id | bigint | FK→card_statements NULL | クレカ取引のみ。属する請求サイクル |
| memo | text | | |

> `transactions.amount = Σ transaction_legs.amount`（アプリ/制約で担保）。

### 5. transaction_legs（支払い脚＝分割支払い）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| transaction_id | bigint | FK→transactions NOT NULL, ON DELETE CASCADE | 親取引 |
| wallet_id | bigint | FK→wallets NOT NULL | 決済手段（出金/入金ウォレット）|
| amount | integer | NOT NULL CHECK(>0) | この脚の金額 |

> 通常は1脚。カード¥8,000＋ポイント¥2,000のような分割は2脚（ADR-025）。
> 残高計算はこの脚を集計（支出ならマイナス、収入ならプラス、type で符号判定）。

### 6. transfers（資金移動）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| from_wallet_id | bigint | FK→wallets NOT NULL | 出金元 |
| to_wallet_id | bigint | FK→wallets NOT NULL, CHECK(≠from) | 入金先 |
| amount | integer | NOT NULL CHECK(>0) | |
| fee | integer | NOT NULL DEFAULT 0 | 手数料 |
| fee_category_id | bigint | FK→categories NULL | 手数料の費用カテゴリ（自動支出計上）|
| kind | text | CHECK('transfer','charge','cash_withdrawal','card_settlement') | 振替/チャージ/現金出し/クレカ消込（ADR-024,026）|
| card_statement_id | bigint | FK→card_statements NULL | kind=card_settlement で消し込む請求 |
| transfer_date | date | NOT NULL | |
| memo | text | | |

> PL（損益）には載らない。クレカ消込＝銀行→カードの transfer 1件＋ statement を paid に（ADR-003）。

### 7. recurring_rules（固定費・サブスクマスタ）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| name | text | NOT NULL | 家賃 等 |
| category_id | bigint | FK→categories NOT NULL | fixed_cost |
| amount | integer | NOT NULL | 定額（予定額）|
| settlement_wallet_id | bigint | FK→wallets NOT NULL | 引落先（みずほ口座 or 各カード / ADR-012）|
| start_month | date | NOT NULL | 開始年月（月初日）|
| end_month | date | NULL | 終了年月。NULL=継続中。解約でセット（ADR-011）|
| billing_day | smallint | | 発生/引落日 |
| is_active | boolean | NOT NULL DEFAULT true | |
| memo | text | | |

### 8. card_statements（クレカ請求サイクル）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| wallet_id | bigint | FK→wallets NOT NULL | 対象カード |
| period_start / period_end | date | NOT NULL | サイクル期間 |
| closing_date | date | NOT NULL | 締め日 |
| payment_date | date | NOT NULL | 引落予定日 |
| settlement_wallet_id | bigint | FK→wallets | 引落先（通常 三井住友）|
| status | text | CHECK('open','closed','paid') DEFAULT 'open' | |
| paid_transfer_id | bigint | FK→transfers NULL | 消込したtransfer |

> `total_amount`（請求合計）は保持せず、紐づく transactions の集計で算出（必要なら後でキャッシュ）。
> 発生日＋カードの締め日設定で、取引をどのサイクルに入れるか自動判定（ADR-023）。

### 9. targets（予実の予算・目標）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| period | date | NOT NULL | 対象年月（月初日）|
| metric | text | NOT NULL CHECK('income','expense','net_balance','total_assets') | 収入/支出/収支/総資産（ADR-018,027）|
| amount | integer | NOT NULL | 予算/目標額 |
| | | UNIQUE(user_id, period, metric) | |

> 実績は transactions/legs から集計。差異・達成率は算出。カテゴリ別予算は持たない（ADR-018）。

### 10. monthly_closings（確定/未確定＝黒塗り）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| period | date | NOT NULL | 年月 |
| section | text | NOT NULL CHECK('income','fixed_cost','variable_cost','assets') | 区分（ADR-020）|
| is_closed | boolean | NOT NULL DEFAULT false | 確定（黒塗り）|
| closed_at | timestamptz | NULL | |
| | | UNIQUE(user_id, period, section) | |

### 11. payslips（給与明細）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| period | date | NOT NULL | 対象年月 |
| total_work_hours | numeric(6,1) | NULL | 総労働時間（KPI / ADR-009）|
| overtime_hours | numeric(6,1) | NULL | 時間外労働時間 |
| is_confirmed | boolean | NOT NULL DEFAULT false | 確定/予定 |
| source | text | CHECK('ocr','manual') | 取込元 |
| | | UNIQUE(user_id, period) | |

> 総支給額・手取り・控除合計・時給換算は payslip_items と労働時間から**算出**（保持しない）。

### 12. payslip_items（給与明細の明細行）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| payslip_id | bigint | FK→payslips NOT NULL, ON DELETE CASCADE | |
| item_type | text | NOT NULL CHECK('allowance','deduction') | 手当/控除 |
| name | text | NOT NULL | 月給, 所得税, 残業代 等 |
| category_id | bigint | FK→categories NULL | 控除はpl_type=deductionカテゴリに紐付け可 |
| amount | integer | NOT NULL | 控除は+で持ち減算。還付は−可（ADR-022）|

> 税金・社保はここ（控除）で管理し、支出には計上しない（二重計上防止 / ADR-022）。

### 13. balance_snapshots（任意のリコンサイル）
| 列 | 型 | 制約 | 説明 |
|----|----|------|------|
| id | bigint | PK | |
| user_id | bigint | FK→users NOT NULL | |
| wallet_id | bigint | FK→wallets NOT NULL | |
| as_of_date | date | NOT NULL | 基準日（月末等）|
| actual_balance | integer | NOT NULL | 実残高（手入力）|
| | | UNIQUE(wallet_id, as_of_date) | |

> 自動算出残高との差分を表示し、記入漏れを検知（ADR-027）。

---

## 「1入力・全連動」検証トレース

設計が要件を満たすか、具体例で各数字への波及を追う。

**A. 朝飯 ¥1,090 を PayPay残高で 4/3**
- transactions{category:朝飯(variable), type:expense, amount:1090, accrual_date:2026-04-03}
- transaction_legs[{wallet:PayPay残高, amount:1090}]
- 波及 → 朝飯→食費(1人)→食費→変動費 の集計 +1090 ／ PayPay残高 −1090 ／ 総資産 −1090 ／ 4月変動費の実績 +1090。**1入力で全部動く。**

**B. EPOSで交際費 ¥8,500 を 4/29（締め日27）→ 翌サイクル**
- transactions{category:交際費, expense, 8500, accrual_date:2026-04-29, card_statement_id: EPOSの「4/28〜5/27」サイクル}
- legs[{wallet:EPOSカード, 8500}]
- 波及 → 交際費は**発生日4月のPL/変動費に計上**（発生主義）／ EPOS未払い +8500 ／ 当該statement(5/27払い)の請求 +8500 ／ 銀行残高は変化なし（まだ引落前）。**EPOSの月跨ぎ手動入れ替えが不要に。**
- 5/27引落: transfers{from:三井住友, to:EPOSカード, amount:サイクル合計, kind:card_settlement} → statement.status=paid ／ 三井住友 −合計 ／ EPOS未払い→0。

**C. チャージ ¥70,000 を EPOS→ANA Pay（4/4）→ 後でPASMOで交通費**
- transfers{from:EPOSカード, to:ANA Pay, 70000, kind:charge} → EPOS未払い +70000 ／ ANA Pay残高 +70000 ／ **PLには載らない（資金移動）**。
- 後日 transfers{ANA Pay→PASMO} → 残高が移動。PASMOで交通費: transactions{category:旅費・交通費, expense} legs[{wallet:PASMO}] → 旅費集計+ ／ PASMO残高−。

**D. 分割払い：¥10,000 の物品を カード¥8,000＋ポイント¥2,000**
- transactions{category:物品購入費, expense, amount:10000}
- legs[{wallet:EPOSカード, 8000}, {wallet:ポイント, 2000}]
- 波及 → 物品購入費 +10000（満額）／ EPOS未払い +8000 ／ ポイント残高 −2000 ／ 変動費実績 +10000。**両建ての手合わせ不要。**
- ポイント獲得時は別途 transactions{type:income, category:ポイント収入} legs[{wallet:ポイント, +}] で残高+。

**E. 経費精算（立替 → 戻り）＝ PL対象外**
- 立替: transactions{category:(excluded)経費立替, expense, amount} legs[{wallet:カード}] → **PLには載らないが**カード未払い+（残高反映）。
- 精算入金: transactions{category:(excluded)経費精算, income, amount} legs[{wallet:三井住友, +}] → PL非計上、三井住友残高+。**記録は両方残るが損益は歪まない（ADR-010）。**

---

## 次のステップ（合意後）
1. この詳細定義のレビュー（違和感・抜けの確認）。
2. PostgreSQL の DDL（CREATE TABLE）に落とす＋初期データ（seed）設計。
3. 画面遷移・API一覧（基本設計の残り）。
