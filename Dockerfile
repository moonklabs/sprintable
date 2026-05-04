# ─── Stage 1: Dependencies ───
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core-storage/package.json packages/core-storage/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/storage-pglite/package.json packages/storage-pglite/package.json
COPY packages/storage-supabase/package.json packages/storage-supabase/package.json
COPY ee/packages/storage-saas/package.json ee/packages/storage-saas/package.json
COPY ee/packages/mcp-server-saas/package.json ee/packages/mcp-server-saas/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── Stage 2: Build ───
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages
COPY . .

# Environment variables for build
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ARG LICENSE_CONSENT=
ENV NODE_ENV=production
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV LICENSE_CONSENT=$LICENSE_CONSENT

RUN pnpm build

# ─── Stage 3: Runtime ───
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3108
ENV HOSTNAME=0.0.0.0

# Copy built artifacts
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/packages/db/supabase/migrations ./migrations

# AC7: Environment validation script
COPY scripts/validate-env.sh /app/validate-env.sh
COPY scripts/run-migrations.sh /app/run-migrations.sh
RUN chmod +x /app/validate-env.sh /app/run-migrations.sh

# psql for migrations
RUN apk add --no-cache postgresql-client

EXPOSE 3108

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3108/api/health || exit 1

# AC5: validate env → auto-run migrations (if DATABASE_URL set) → start
ENTRYPOINT ["/bin/sh", "-c", "/app/validate-env.sh && if [ -n \"$DATABASE_URL\" ]; then /app/run-migrations.sh \"$DATABASE_URL\"; fi && node apps/web/server.js"]
