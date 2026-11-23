import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // 全テストが1つのテストDBを共有するため、並列実行は禁止（相互汚染の防止）
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    env: {
      // 本番/開発DB(pl_app)ではなく専用テストDBを必ず向く。
      // .env.local は読み込まない（Vitestはデフォルトで読まない）。
      // 既定は pl_app_test。並列でテストを書くときは PLTEST_DB で
      // ワーカー専用DB（例: pl_app_w1_test）に切り替える。名前は必ず _test で終わること
      // （tests/setup.ts のガードが実データDBへの接続を停止する）。
      DATABASE_URL: `postgresql://postgres@localhost:5432/${process.env.PLTEST_DB ?? "pl_app_test"}`,
      // 認証envを空にすることで authEnabled()=false → currentUserId()=1 となり、
      // next/headers の cookies() を呼ばずにクエリ層を直接テストできる。
      AUTH_SECRET: "",
      AUTH_USER: "",
      AUTH_PASSWORD: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      // メール送信を絶対に発火させない
      RESEND_API_KEY: "",
    },
  },
});
