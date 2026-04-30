# D-S2: Next.js standalone 빌드용 Dockerfile
# 빌드 컨텍스트: 레포 루트 (cloudbuild.yaml에서 실행)
FROM node:20-alpine AS base
RUN corepack enable pnpm

# ─── 의존성 설치 ──────────────────────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# packages 디렉토리 (workspace 패키지들)
COPY packages/ packages/
COPY apps/web/package.json apps/web/
# web 앱과 의존 workspace 패키지만 설치
RUN pnpm install --frozen-lockfile --filter web...

# ─── 빌드 ────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY packages/ packages/
COPY apps/web/ apps/web/
# ee overlay (SaaS 빌드 시 주입, OSS에서는 빈 디렉토리 허용)
COPY ee/ ee/
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ─── 런타임 ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
