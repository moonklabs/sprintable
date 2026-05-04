import type { BackgroundRuntimeWorker } from '@/services/background-runtime';

declare global {
  var __backgroundRuntimeWorker: BackgroundRuntimeWorker | undefined;
}

export async function register() {
  if (process.env.NODE_ENV === 'test') return;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // OSS 모드: PGLite DB 초기화 (최초 기동 시 ~/.sprintable/data/pglite/ 생성)
    if (process.env['OSS_MODE'] === 'true') {
      const { getDb } = await import('@sprintable/storage-pglite');
      await getDb();
    }

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
