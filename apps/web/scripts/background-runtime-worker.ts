import { createBackgroundRuntimeWorkerFromEnv, shouldStartBackgroundRuntime } from '../src/services/background-runtime';

if (!shouldStartBackgroundRuntime(process.env)) {
  throw new Error('SPRINTABLE_RUNTIME_ROLE must be worker or all to run the background worker');
}

const backgroundRuntimeWorker = createBackgroundRuntimeWorkerFromEnv(process.env);
if (!backgroundRuntimeWorker) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

backgroundRuntimeWorker.start();

const shutdown = async () => {
  await backgroundRuntimeWorker.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
