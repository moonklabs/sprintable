import type { SupabaseClient } from '../src/types/supabase';
import { SlackOutboundDispatcher } from '../src/services/slack-outbound-dispatcher';

// OSS mode: no Supabase client; service skips Supabase-dependent paths when db is absent
const dispatcher = new SlackOutboundDispatcher({
  db: undefined as unknown as SupabaseClient,
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
});

dispatcher.start();

const shutdown = async () => {
  await dispatcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
