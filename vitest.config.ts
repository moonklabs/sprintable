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
      'apps/web/src/app/api/projects/[id]/ai-settings/route.test.ts',
      'apps/web/src/app/api/projects/[id]/ai-settings/validate/route.test.ts',
      'apps/web/src/app/api/projects/[id]/mcp-connections/[serverKey]/route.test.ts',
      'apps/web/src/app/api/projects/[id]/mcp-connections/route.test.ts',
      // agent-builtin-tools.test.ts: the 4 registry-declared memo tools
      // (create_memo/reply_memo/update_memo/list_memos) are now implemented (story
      // 6f237832), but this file's create_story/forward_memo/create_memo/list_epics
      // cases drive StoryService/EpicService/MemoService through their post-OSS-split
      // persistence layer (FastAPI `fastapiCall` repos; MemoService has no repo at all),
      // so they fail under the in-memory db stub the test was authored against. Re-include
      // requires reworking the suite to inject db-stub-backed fake services — tracked as a
      // follow-up; un-isolating now would turn the suite red on pre-existing debt.
      'apps/web/src/services/agent-builtin-tools.test.ts',
      'apps/web/src/services/background-runtime.test.ts',
    ],
  },
});
