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
    // story #3466(카디르 QA REQUEST_CHANGES, 2026-08-25) — window.matchMedia jsdom 갭 전역 폴백.
    // vitest.setup.ts 참고(왜 top-level 1회가 아니라 beforeEach인지 그 파일에 설명). 절대경로로
    // 넘긴다 — apps/web에서 CWD로 실행되는 vitest 호출부(package.json test 스크립트 등)가
    // './vitest.setup.ts'를 자기 CWD 기준으로 잘못 찾는 것을 막는다(위 resolve.alias와 동일 원칙).
    // story #4333 — 테스트가 저장소 트리에 쓰면 즉시 실패(전체 판 스캐너끼리 실 트리 임시 파일로 서로 흔들던 결함). 맨 앞에 둬 다른 설정 파일의 쓰기도 본다.
    setupFiles: [
      fileURLToPath(new URL('./vitest.repo-write-guard.ts', import.meta.url)),
      fileURLToPath(new URL('./vitest.setup.ts', import.meta.url)),
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/e2e/**',
      // QA worktrees are transient PR review directories, excluded from main test runs
      '.qa-worktrees/**',
      // connectors/ is a no-package.json reference-SDK area (bun/pytest, unconfigured
      // convention shared with the sibling Python tests) — its *.test.ts files use
      // bun:test, not vitest, and vitest crashes trying to resolve that import (#2578 QA).
      'connectors/**',
      // QUARANTINE manifest (story 2d5c8662) — fully burned down (Group B, owner 디디).
      // The last quarantined file (agent-builtin-tools.test.ts) was re-included once its
      // service deps were reworked to db-stub-backed fakes (story 7a57e7b1). Keep this
      // list to genuine infra exclusions only; fix failing tests instead of quarantining.
    ],
  },
});
