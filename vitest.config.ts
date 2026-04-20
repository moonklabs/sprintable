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
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/e2e/**'],
  },
});
