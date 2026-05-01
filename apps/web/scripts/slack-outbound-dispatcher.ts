import { SlackOutboundDispatcher } from '../src/services/slack-outbound-dispatcher';

const dispatcher = new SlackOutboundDispatcher({
  db: undefined,
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
});

dispatcher.start();

const shutdown = async () => {
  await dispatcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
