import { BackgroundRuntimeWorker, createBackgroundRuntimeWorkerFromEnv, shouldStartBackgroundRuntime } from '@/services/background-runtime';

declare global {
  var __backgroundRuntimeWorker: BackgroundRuntimeWorker | undefined;
}

export async function register() {
  if (process.env.NODE_ENV === 'test') return;
  if (!shouldStartBackgroundRuntime(process.env)) return;
  if (globalThis.__backgroundRuntimeWorker) return;

  const backgroundRuntimeWorker = createBackgroundRuntimeWorkerFromEnv(process.env);
  if (!backgroundRuntimeWorker) return;

  backgroundRuntimeWorker.start();
  globalThis.__backgroundRuntimeWorker = backgroundRuntimeWorker;
}
