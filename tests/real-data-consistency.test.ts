// 実データ（本番相当のコピー）に対する内部整合チェック。
// フィクスチャは小さく作為的なので、本物のデータ形状で崩れないかを確かめる。
import { describe, it, expect, afterAll } from "vitest";
import pool from "@/lib/db";
import {
  getVariableLeaves, getVariableGroups, getPLSummary, getMonthlyIncomeRows,
  getAssets, getAssetBreakdown, getFiscalYearPL, getFiscalYearTotal, getReconcileData,
} from "@/lib/queries";

// 実データのコピーに対してだけ走らせる。作り方:
//   pg_dump -Fc -d pl_app -f backups/xxx.dump
//   createdb pl_app_real_test && pg_restore -d pl_app_real_test backups/xxx.dump
//   PLTEST_DB=pl_app_real_test npx vitest run tests/real-data-consistency.test.ts
// 通常の npm test では自動でスキップされる（フィクスチャDBには実データが無いため）。
const REAL = process.env.PLTEST_DB === "pl_app_real_test";

afterAll(async () => { await pool.end(); });

const MONTHS = ["2026-04-01","2026-05-01","2026-06-01","2026-07-01","2026-08-01","2026-09-01"];

describe.skipIf(!REAL)("実データでの内部整合", () => {
  it("変動費: 明細合計 = グループ合計 = PLサマリ（全月）", async () => {
    for (const m of MONTHS) {
      const leaves = (await getVariableLeaves(m)).reduce((s, r) => s + r.total, 0);
      const groups = (await getVariableGroups(m)).reduce((s, r) => s + r.total, 0);
      const pl = (await getPLSummary(m)).variable;
      console.log(`  ${m}  明細=${leaves}  グループ=${groups}  PL=${pl}`);
      expect(leaves, `${m} 明細 vs グループ`).toBe(groups);
      expect(leaves, `${m} 明細 vs PLサマリ`).toBe(pl);
    }
  });

  it("収入: 明細合計 = 可処分所得（全月）", async () => {
    for (const m of MONTHS) {
      const rows = await getMonthlyIncomeRows(m);
      const inc = rows.filter((r) => r.pl_type === "income").reduce((s, r) => s + r.total, 0);
      const pl = (await getPLSummary(m)).disposable;
      console.log(`  ${m}  収入明細=${inc}  可処分所得=${pl}`);
      expect(inc, `${m}`).toBe(pl);
    }
  });

  it("資産: 内訳合計 = 総資産", async () => {
    const a = await getAssets();
    const bd = await getAssetBreakdown();
    const sum = bd.reduce((s, r) => s + r.total, 0);
    console.log(`  総資産=${a.total_assets} / 内訳合計=${sum} / カード未払い=${a.card_unpaid} / 純資産=${a.net_assets}`);
    expect(a.net_assets).toBe(a.total_assets - a.card_unpaid);
  });

  it("年度: 月次PLの合計 = 年計", async () => {
    const months = await getFiscalYearPL("2026-04-01");
    const total = await getFiscalYearTotal("2026-04-01");
    const sum = months.reduce(
      (s, m) => ({ income: s.income + m.income, fixed: s.fixed + m.fixed, variable: s.variable + m.variable }),
      { income: 0, fixed: 0, variable: 0 }
    );
    console.log(`  月次合計 収入=${sum.income} 固定=${sum.fixed} 変動=${sum.variable}`);
    console.log(`  年計     収入=${total.income} 固定=${total.fixed} 変動=${total.variable}`);
    expect(sum.income).toBe(total.income);
    expect(sum.variable).toBe(total.variable);
  });

  it("照合画面: 全ウォレットの算出残高が数値で返る（crypto含む）", async () => {
    const rows = await getReconcileData();
    console.log(`  照合対象 ${rows.length}件`);
    for (const r of rows) {
      expect(Number.isFinite(r.computed), `${r.name}`).toBe(true);
    }
    const crypto = rows.filter((r) => r.type === "crypto");
    console.log(`  crypto: ${crypto.map((c) => `${c.name} computed=${c.computed} actual=${c.actual}`).join(" / ")}`);
    // ADR-043: cryptoはスナップショットが「正」なので差分は0であるべき
    for (const c of crypto) {
      if (c.actual != null) expect(c.computed, `${c.name} の差分`).toBe(c.actual);
    }
  });
});
