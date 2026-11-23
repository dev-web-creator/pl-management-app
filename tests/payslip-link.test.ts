// 給与明細 → 月次「給与収入(手取り)」の自動連動（ADR-049）。
// 手取りが二重に計上されたり、明細を消しても収入が残ったりしないかを見る。
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pool from "@/lib/db";
import { resetDb, addTx, type Ids } from "./helpers/fixtures";
import { POST as postPayslip } from "@/app/api/payslips/route";
import { DELETE as deletePayslip } from "@/app/api/payslips/[id]/route";
import { getPLSummary } from "@/lib/queries";

let ids: Ids;

function save(b: unknown) {
  return postPayslip(new Request("http://localhost/api/payslips", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
  }));
}
function del(id: number) {
  return deletePayslip(
    new Request(`http://localhost/api/payslips/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: String(id) }) }
  );
}
const payslipBody = (ids: Ids, net: { gross: number; ded: number }) => ({
  period: "2026-09",
  salary_wallet_id: ids.wallet["銀行A"],
  allowances: [{ name: "基本給", amount: net.gross }],
  deductions: [{ name: "社会保険料", amount: net.ded }],
});
const salaryRows = () =>
  pool.query(
    `select t.id, t.amount, t.client_key from transactions t
     join categories c on c.id=t.category_id
     where c.name='給与収入(手取り)' order by t.id`
  );

beforeEach(async () => { ids = await resetDb(); });
afterAll(async () => { await pool.end(); });

describe("給与明細の連動", () => {
  it("保存すると手取りが収入として1件作られる", async () => {
    const res = await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.salary_linked).toBe(true);
    expect(d.net).toBe(420000);

    const rows = await salaryRows();
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].amount).toBe(420000);
  });

  it("同じ月の明細を3回保存しても収入は1件のまま（冪等）", async () => {
    await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    await save(payslipBody(ids, { gross: 500000, ded: 80000 }));

    const rows = await salaryRows();
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].amount).toBe(420000);
  });

  it("金額を訂正して保存し直すと、収入も新しい金額に置き換わる", async () => {
    await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    await save(payslipBody(ids, { gross: 520000, ded: 80000 }));

    const rows = await salaryRows();
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].amount).toBe(440000);
    expect((await getPLSummary("2026-09-01")).disposable).toBe(440000);
  });

  it("手入力の給与収入とは別物として扱われる（連動側は手入力に触れない）", async () => {
    await addTx(ids, {
      category: "給与収入(手取り)", type: "income", amount: 300000,
      date: "2026-09-25", wallet: "銀行A", memo: "手入力",
    });
    await save(payslipBody(ids, { gross: 500000, ded: 80000 }));

    const rows = await salaryRows();
    // 手入力は消されない＝同月に2件並ぶ。合計は単純加算される。
    expect(rows.rowCount).toBe(2);
    expect((await getPLSummary("2026-09-01")).disposable).toBe(720000);
  });

  it("明細を削除すると連動した収入も消える", async () => {
    const r = await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    const pid = (await r.json()).id;
    expect((await salaryRows()).rowCount).toBe(1);

    expect((await del(pid)).status).toBe(200);

    const rows = await salaryRows();
    expect(rows.rowCount).toBe(0);
    expect((await getPLSummary("2026-09-01")).disposable).toBe(0);
  });

  it("明細を削除しても手入力の給与収入は残る", async () => {
    await addTx(ids, {
      category: "給与収入(手取り)", type: "income", amount: 300000,
      date: "2026-09-25", wallet: "銀行A", memo: "手入力",
    });
    const r = await save(payslipBody(ids, { gross: 500000, ded: 80000 }));
    const pid = (await r.json()).id;

    await del(pid);

    const rows = await salaryRows();
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].amount).toBe(300000);
  });
});
