import { MemoEventDispatcher } from '../src/services/memo-event-dispatcher';

const dispatcher = new MemoEventDispatcher({ db: undefined });

dispatcher.start();

const shutdown = async () => {
  await dispatcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
