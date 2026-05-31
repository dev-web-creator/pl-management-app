import { Pool } from "pg";

// 接続プール（アプリ全体で1つ使い回す）
// DATABASE_URL は .env.local に記載: postgresql://postgres@localhost:5432/pl_app
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;
