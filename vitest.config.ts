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
    ],
  },
});
