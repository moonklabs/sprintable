import type { BackgroundRuntimeWorker } from '@/services/background-runtime';

declare global {
  var __backgroundRuntimeWorker: BackgroundRuntimeWorker | undefined;
}

export async function register() {
  if (process.env.NODE_ENV === 'test') return;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // story #4299 AC2 — BFF의 모든 서버 fetch(route handler · RSC · 미들웨어)가 같은 연결 풀을 쓰게 전역 디스패처를 한 번 바꾼다
    // (keep-alive 60초 · 백엔드 origin만 h2 + 동시 스트림). 백그라운드 워커 여부와 무관하게 먼저.
    const { installBffDispatcher } = await import('@/lib/server-dispatcher');
    installBffDispatcher();

    if (globalThis.__backgroundRuntimeWorker) return;

    const { createBackgroundRuntimeWorkerFromEnv, shouldStartBackgroundRuntime } = await import(
      '@/services/background-runtime'
    );

    if (!shouldStartBackgroundRuntime(process.env)) return;

    const backgroundRuntimeWorker = createBackgroundRuntimeWorkerFromEnv(process.env);
    if (!backgroundRuntimeWorker) return;

    backgroundRuntimeWorker.start();
    globalThis.__backgroundRuntimeWorker = backgroundRuntimeWorker;
  }
}
