import type { BackgroundRuntimeWorker } from '@/services/background-runtime';

declare global {
  var __backgroundRuntimeWorker: BackgroundRuntimeWorker | undefined;
}

export async function register() {
  if (process.env.NODE_ENV === 'test') return;
  if (globalThis.__backgroundRuntimeWorker) return;

  if (process.env.NEXT_RUNTIME === 'nodejs') {
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
