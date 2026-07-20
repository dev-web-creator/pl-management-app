import Link from "next/link";
import { getWalletsForManagement } from "@/lib/queries";
import { requireAuth } from "@/lib/auth";
import WalletManager from "@/components/WalletManager";

export const dynamic = "force-dynamic";

export default async function WalletsPage() {
  await requireAuth();
  const wallets = await getWalletsForManagement();

  return (
    <main className="min-h-screen px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <header className="flex items-center justify-between">
          <h1 className="text-xl font-bold">🏦 口座・カードの管理</h1>
          <Link href="/settings" className="text-xs text-sky-600 hover:underline">← 設定</Link>
        </header>

        <section className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-[11px] text-slate-500 mb-4">
            あなたが使う銀行口座・クレジットカード・電子マネー・ポイントを登録します。ここで登録したものが、
            取引入力の「決済手段」や固定費の「引落先」の選択肢になります。クレカは締め日・支払日を入れると
            請求サイクルと引落予定が自動計算されます。
          </p>
          <WalletManager wallets={wallets} />
        </section>

        <p className="text-center text-xs text-slate-400">
          残高は取引・振替から自動算出（残高カラムは持ちません）。「開始残高」は登録時点のおおよその残高を起点にするための値です。
        </p>
      </div>
    </main>
  );
}
