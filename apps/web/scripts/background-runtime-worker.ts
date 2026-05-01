import { createBackgroundRuntimeWorkerFromEnv, shouldStartBackgroundRuntime } from '../src/services/background-runtime';

if (!shouldStartBackgroundRuntime(process.env)) {
  throw new Error('SPRINTABLE_RUNTIME_ROLE must be worker or all to run the background worker');
}

const backgroundRuntimeWorker = createBackgroundRuntimeWorkerFromEnv(process.env);
if (!backgroundRuntimeWorker) {
  throw new Error('Background runtime worker could not be initialized. Check environment configuration.');
}

backgroundRuntimeWorker.start();

const shutdown = async () => {
  await backgroundRuntimeWorker.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
