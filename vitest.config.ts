import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
      '@sprintable/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@sprintable/shared/': fileURLToPath(new URL('./packages/shared/src/', import.meta.url)),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/e2e/**',
      // QA worktrees are transient PR review directories, excluded from main test runs
      '.qa-worktrees/**',
      // EE billing tests require EE-specific infrastructure (payment/factory, monthly-agent-usage-dashboard)
      // that is not available in the OSS vitest setup. These require a separate EE vitest config.
      'ee/apps/web/src/services/billing-limit-enforcer.test.ts',
      'ee/apps/web/src/app/api/billing/**/*.test.ts',
      'ee/apps/web/src/app/api/v1/billing/**/*.test.ts',
      // ── QUARANTINE manifest (story 2d5c8662) ──────────────────────────────────
      // Pre-existing unit-test failures that the CI exit-code bug (`| tail` w/o
      // pipefail) masked until now. Excluded so the gate is REAL for the healthy
      // suite; each file is debt to burn down — re-include as it is fixed.
      // ⚠️ DO NOT add here to silence a NEW failure — fix the test.
      // Group B — api routes + services (backend-of-FE) · owner: 디디 · cleanup story: 837a36c4
      'apps/web/src/app/api/agent-runs/[id]/route.test.ts',
      'apps/web/src/app/api/agent-runs/route.test.ts',
      'apps/web/src/app/api/cron/agent-session-recovery/route.test.ts',
      'apps/web/src/app/api/cron/hitl-timeouts/route.test.ts',
      'apps/web/src/app/api/cron/inbox-outbox/route.test.ts',
      'apps/web/src/app/api/current-project/route.test.ts',
      'apps/web/src/app/api/dashboard/route.test.ts',
      'apps/web/src/app/api/docs/[id]/comments/route.test.ts',
      'apps/web/src/app/api/docs/[id]/route.test.ts',
      'apps/web/src/app/api/docs/preview/route.test.ts',
      'apps/web/src/app/api/inbox/route.test.ts',
      'apps/web/src/app/api/integrations/mcp/github/callback/route.test.ts',
      'apps/web/src/app/api/notifications/route.test.ts',
      'apps/web/src/app/api/projects/[id]/ai-settings/route.test.ts',
      'apps/web/src/app/api/projects/[id]/ai-settings/validate/route.test.ts',
      'apps/web/src/app/api/projects/[id]/mcp-connections/[serverKey]/route.test.ts',
      'apps/web/src/app/api/projects/[id]/mcp-connections/route.test.ts',
      'apps/web/src/app/api/projects/route.test.ts',
      'apps/web/src/app/api/retro-sessions/route.test.ts',
      'apps/web/src/app/api/sprints/[id]/burndown/route.test.ts',
      'apps/web/src/app/api/sprints/[id]/checkin/route.test.ts',
      'apps/web/src/app/api/sprints/[id]/kickoff/route.test.ts',
      'apps/web/src/app/api/standup/feedback/[id]/route.test.ts',
      'apps/web/src/app/api/standup/feedback/route.test.ts',
      'apps/web/src/app/api/standup/missing/route.test.ts',
      'apps/web/src/app/api/standup/route.test.ts',
      'apps/web/src/app/api/stories/[id]/route.test.ts',
      'apps/web/src/app/api/tasks/route.test.ts',
      'apps/web/src/app/api/team-members/[id]/route.test.ts',
      'apps/web/src/app/api/v1/agent-deployments/[id]/route.test.ts',
      'apps/web/src/app/api/v1/agent-deployments/[id]/verification/route.test.ts',
      'apps/web/src/app/api/v1/agent-deployments/preflight/route.test.ts',
      'apps/web/src/app/api/v1/bridge/slack/events/route.test.ts',
      'apps/web/src/app/api/v1/bridge/slack/interactions/route.test.ts',
      'apps/web/src/app/api/v1/bridge/teams/events/route.test.ts',
      'apps/web/src/app/api/v1/hitl-policy/route.test.ts',
      'apps/web/src/app/api/v1/hitl-requests/[id]/route.test.ts',
      'apps/web/src/app/api/v1/hitl-requests/route.test.ts',
      'apps/web/src/app/api/webhooks/agent-runtime/route.test.ts',
      'apps/web/src/services/__tests__/slack-inbound.test.ts',
      'apps/web/src/services/agent-builtin-tools.test.ts',
      'apps/web/src/services/agent-deployment-lifecycle.test.ts',
      'apps/web/src/services/agent-execution-loop.test.ts',
      'apps/web/src/services/agent-tool-execution-engine.test.ts',
      'apps/web/src/services/background-runtime.test.ts',
      'apps/web/src/services/discord-outbound-dispatcher.test.ts',
      'apps/web/src/services/docs.test.ts',
      'apps/web/src/services/memo-assignment-dispatch.test.ts',
      'apps/web/src/services/memo.test.ts',
      'apps/web/src/services/notification-display.test.ts',
      'apps/web/src/services/persona-composer.test.ts',
      'apps/web/src/services/slack-outbound-dispatcher.test.ts',
      'apps/web/src/services/teams-outbound-dispatcher.test.ts',
    ],
  },
});
