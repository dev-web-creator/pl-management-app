# ============================================================
#  Next.js (standalone) 本番イメージ — AWS App Runner / ECS Fargate 向け
#  ビルド: docker build -t pl-app .
#  実行:   docker run -p 3000:3000 -e DATABASE_URL=... pl-app
# ============================================================

# ---- 依存解決 ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- ビルド ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 実行（最小） ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# 非rootユーザーで動かす（セキュリティ）
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# standalone 出力のエントリポイント
# App Runner は実行時に HOSTNAME をコンテナ名で上書きするため、
# 起動コマンド側で 0.0.0.0 バインドを強制する（でないとヘルスチェック不通）
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 node server.js"]
