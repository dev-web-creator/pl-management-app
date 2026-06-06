import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // コンテナ(AWS App Runner / ECS Fargate)向けに最小実行物を出力
  output: "standalone",
};

export default nextConfig;
