import Link from "next/link";
import { listTables, getTableDump } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic"; // 毎回DBの最新を見る

// 読みやすい順（マスタ→取引→その他）
const PREFERRED = [
  "users",
  "wallets",
  "categories",
  "transactions",
  "transaction_legs",
  "transfers",
  "recurring_rules",
  "card_statements",
  "targets",
  "monthly_closings",
  "payslips",
  "payslip_items",
  "balance_snapshots",
];

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    const ymd = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return hasTime ? `${ymd} ${p(v.getHours())}:${p(v.getMinutes())}` : ymd;
  }
  return String(v);
}

export default async function Inspect({
  searchParams,
}: {
  searchParams: Promise<{ key?: string }>;
}) {
  await requireAuth();
  // ルート単位の保護（サイト全体のmiddlewareは使わない＝過去の全ルート500を回避）。
  // 本番(production)では INSPECT_KEY 環境変数が必須＋ ?key= 一致で閲覧可。
  // キー未設定の本番は「安全側に倒してロック」。ローカル開発(development)は常に閲覧可。
  const { key } = await searchParams;
  const expected = process.env.INSPECT_KEY;
  const isProd = process.env.NODE_ENV === "production";
  const locked = isProd ? !expected || key !== expected : false;
  if (locked) {
    return (
      <main className="min-h-screen grid place-items-center p-6 text-center text-slate-700">
        <div>
          <h1 className="text-lg font-bold mb-2">🔒 DBインスペクターは保護されています</h1>
          <p className="text-sm text-slate-500">
            本番では閲覧キーが必要です。<code>?key=あなたのキー</code> を付けてアクセスしてください。
            <br />
            （Vercelの環境変数 <code>INSPECT_KEY</code> を設定 → <code>/inspect?key=…</code>）
          </p>
        </div>
      </main>
    );
  }

  const tables = await listTables();
  const ordered = [
    ...PREFERRED.filter((t) => tables.includes(t)),
    ...tables.filter((t) => !PREFERRED.includes(t)),
  ];
  const dumps = await Promise.all(
    ordered.map((t) => getTableDump(t).then((d) => ({ name: t, ...d })))
  );

  return (
    <main className="min-h-screen bg-slate-100 p-4 text-slate-900">
      <div className="max-w-6xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🔍 DBインスペクター（pl_app の中身）</h1>
          <Link href="/" className="text-sm text-sky-600 hover:underline">
            ← ダッシュボードへ
          </Link>
        </header>
        <p className="text-xs text-slate-500 bg-amber-50 border border-amber-200 rounded-lg p-3">
          読み取り専用・各テーブル先頭200件まで。
          ダッシュボードの「＋ 取引を入力」で1件足してから、このページを再読み込みすると、
          <b> transactions と transaction_legs に新しい行が増える</b>のが見えます（＝裏側で起きていること）。
        </p>

        {dumps.map((d) => (
          <section key={d.name} className="bg-white rounded-xl shadow-sm p-4 overflow-x-auto">
            <h2 className="font-bold mb-2">
              {d.name}{" "}
              <span className="text-xs font-normal text-slate-400">
                ({d.total}件{d.total > d.shown ? ` 中 先頭${d.shown}件` : ""})
              </span>
            </h2>
            {d.rows.length === 0 ? (
              <p className="text-sm text-slate-400">（空）</p>
            ) : (
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    {d.columns.map((c) => (
                      <th
                        key={c}
                        className="border border-slate-200 px-2 py-1 bg-slate-50 text-left whitespace-nowrap"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((row, i) => (
                    <tr key={i} className="even:bg-slate-50/50">
                      {d.columns.map((c) => (
                        <td
                          key={c}
                          className="border border-slate-200 px-2 py-1 whitespace-nowrap tabular-nums"
                        >
                          {fmt(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
