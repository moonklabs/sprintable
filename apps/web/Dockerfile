# D-S2: Next.js standalone 빌드용 Dockerfile
# 빌드 컨텍스트: 레포 루트 (cloudbuild.yaml에서 실행)
# story #2640(P0 실사고, 2026-08-13 21:05): docker.io 익명 pull이 429로 Cloud Build를
# 죽였다(build beb26450) — mirror.gcr.io로 전환해 그 rate-limit 표면 자체를 없앤다.
# Docker daemon registry-mirror 설정이 아니라 FROM에 직접 참조하는 방식(Cloud Build 표준
# `gcr.io/cloud-builders/docker` 스텝은 daemon.json을 못 건드림) — 실측(2026-08-14, 디디):
# 흔치 않은 태그(node:20.11.1-alpine3.19)도 온디맨드 fetch-through 성공, 존재하지 않는
# 태그는 정상 404("not found") — 캐시 미스가 조용히 깨지는 새 실패 모드가 아님을 확認.
FROM mirror.gcr.io/library/node:20-alpine AS base
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
# story #3731(3729 후속) — 레포 루트 scripts/를 여기 COPY하는 핫픽스는 걷었다. 공유
# 파서(구 scripts/i18n-key-parser.js)를 packages/scripts/로 이관해 이미 위 `COPY
# --from=deps /app/packages ./packages`가 담고 있다 — 루트 scripts/를 이 목록에 남겨
# 두면 「apps/web 밖 import ⊆ COPY 집합」 가드(verify-frontend-docker-import-context.ts)의
# 허용 접두에 scripts/가 들어가 그 가드가 «루트 scripts/ 재발»을 영영 못 보게 된다
# (걷은 뒤 apps/web 비-테스트 전수 재스캔 0건 확認 — 이관이 근본 봉쇄임을 실측).
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# story #4225(dev 배포 19 실사고, 2026-09-23 build b6c4ff7d) — `pnpm build`가 webpack 컴파일 중 `JavaScript heap out
# of memory`로 죽었다(123초 · old space 1715/2018MB). Node는 힙 상한을 지정하지 않으면 머신 메모리로 정한다 —
# Cloud Build E2_HIGHCPU_8(8GB)에선 ≈2GB(node:20-alpine 실측 2096MB)라, 코드가 늘며 그 선에 닿았다. 8GB 머신에서
# 6GB를 준다. 이 builder 스테이지의 ENV라 아래 runner 이미지엔 안 실린다(런타임 힙은 Cloud Run 메모리 기준 그대로).
ENV NODE_OPTIONS=--max-old-space-size=6144
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
# story #2728 후속(2026-08-17) — apps/web/src/lib/ee.ts의 isEEEnabled()가 읽는 빌드타임
# 인라인 값. 여태 ARG/ENV 어디에도 배선된 적이 없어 dev/prod 둘 다 항상 undefined(=false)
# 였다 — 기본값 false(미설정 시 dev-safe fallback, SSE_MULTIPLEX_ENABLED와 동일 컨벤션).
ARG NEXT_PUBLIC_EE_ENABLED=false
ENV NEXT_PUBLIC_EE_ENABLED=${NEXT_PUBLIC_EE_ENABLED}
# story #3260(2026-08-31, 페드루 PO 조건부 승인) — apps/web/src/lib/support-widget-flag.ts의
# isSupportWidgetEnabled()가 읽는 빌드타임 인라인 값. EE_ENABLED와 동일 컨벤션 — 기본값
# false(미설정 시 dev-safe fallback). Support Gateway(#f2a27d2a) 착지·AC2/AC3 실측 前까지
# 항상 unavailable인 런처를 화면에 노출하지 않기 위한 게이트.
ARG NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED=false
ENV NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED=${NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED}
# story #3260 Phase 2 — 위젯이 Support Gateway를 브라우저에서 직접 호출(BFF 프록시 없음)하는
# 데 필요한 그 서비스의 base URL. 기본값 빈 문자열(dev-safe fallback, 위 컨벤션과 동일).
ARG NEXT_PUBLIC_SUPPORT_GATEWAY_URL=""
ENV NEXT_PUBLIC_SUPPORT_GATEWAY_URL=${NEXT_PUBLIC_SUPPORT_GATEWAY_URL}
# story #2758(2026-08-18) — apps/web/src/ee/components/billing/toss-checkout.ts(story #2510)가
# 읽는 Toss 결제위젯 clientKey. manual-env-allowlist.yml에 declared_by:PO로 「등재」만 되고
# ARG/ENV 어디에도 배선된 적이 없어(EE_ENABLED·LICENSE_CONSENT와 동형 「등재≠배선」 3번째)
# dev FE에 값이 아예 없었다. publishable 값(secret 아님, 브라우저 노출 전제) — 기본값 빈
# 문자열(미설정 시 dev-safe fallback, 위 컨벤션과 동일).
ARG NEXT_PUBLIC_TOSS_CLIENT_KEY=""
ENV NEXT_PUBLIC_TOSS_CLIENT_KEY=${NEXT_PUBLIC_TOSS_CLIENT_KEY}
# story #3947(2026-09-16, 페드루 PO 판정) — apps/web/src/lib/public-app-host.ts의
# getPublicAppHost()가 읽는 빌드타임 인라인 값. cloudbuild.yaml `_NEXT_PUBLIC_APP_URL`은
# dev/prod로 이미 정확히 분기(cloud-build.yml steps.env)돼 있었지만 이 Dockerfile의
# ARG/ENV 어디에도 배선된 적이 없어(EE_ENABLED·TOSS_CLIENT_KEY와 동형 「분기는 있는데
# 이 스테이지까지 안 옴」 클래스) 빌드 시점엔 항상 undefined — dev-app이 코드 하드코딩
# localhost fallback을 그대로 인라인했다. 기본값을 안 둔다(다른 ARG들과 결이 다름 —
# 이 값이 없으면 next.config.ts의 배포 빌드 가드(SPRINTABLE_DEPLOY_BUILD 마커 참고,
# 아래)가 `pnpm build`를 즉시 실패시켜야 한다, "조용한 fallback" 자체가 이 카드의
# 사고 원인이었다).
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
# story #3947 CHANGES(카디르 재현) — 위 가드를 처음엔 NODE_ENV=production으로 걸었는데
# `next build`는 로컬 smoke test·CI 검증 빌드에서도 항상 이 값을 강제해 무관 빌드까지
# 죽였다(ci.yml "Lint, Type Check, Test, Build"·docker-smoke-test.yml 둘 다 실사고
# 직전). 이 마커는 **cloudbuild.yaml의 진짜 Cloud Build 배포 빌드에서만** 심긴다(다른
# 어떤 파이프라인도 이 값을 안 심음) — "이게 실제 배포 빌드인가"를 NODE_ENV와 분리해서
# 묻는다.
ARG SPRINTABLE_DEPLOY_BUILD
ENV SPRINTABLE_DEPLOY_BUILD=${SPRINTABLE_DEPLOY_BUILD}
RUN pnpm build

# ─── 런타임 ──────────────────────────────────────────────────────────────────
# story #2640: 위 base 스테이지와 동일 이유(mirror.gcr.io) — runner는 base에서 파생되지
# 않는 별도 스테이지라 여기도 따로 전환 필요.
FROM mirror.gcr.io/library/node:20-alpine AS runner
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
