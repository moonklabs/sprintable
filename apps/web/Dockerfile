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
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages
COPY apps/web/ apps/web/
# ee overlay (SaaS 빌드 시 주입, OSS에서는 빈 디렉토리 허용)
COPY ee/ ee/
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# rewrites()가 빌드 시점에 routes-manifest.json으로 베이크인되므로 ARG로 주입 필요
ARG NEXT_PUBLIC_FASTAPI_URL
ENV NEXT_PUBLIC_FASTAPI_URL=${NEXT_PUBLIC_FASTAPI_URL}
ARG NEXT_PUBLIC_OAUTH_ENABLED
ENV NEXT_PUBLIC_OAUTH_ENABLED=${NEXT_PUBLIC_OAUTH_ENABLED}
ARG NEXT_PUBLIC_GA4_MEASUREMENT_ID
ENV NEXT_PUBLIC_GA4_MEASUREMENT_ID=${NEXT_PUBLIC_GA4_MEASUREMENT_ID}
# story #2078(E-ARCH 0단계) — SSE 멀티플렉서 롤백 플래그. dev만 GO(오르테가군 판정,
# 2026-07-21) — prod는 develop→main 48커밋 일괄승격에 얹으면 문제 발생 시 원인 격리가
# 안 돼 별도 판단으로 미룬다. 기본값 false(미설정 시 dev-safe fallback).
ARG NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED=false
ENV NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED=${NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED}
RUN pnpm build

# ─── 런타임 ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]
