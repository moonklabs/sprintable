import type { SupabaseClient } from '../src/types/supabase';
import { MemoEventDispatcher } from '../src/services/memo-event-dispatcher';

// OSS mode: no Supabase client; service skips Supabase-dependent paths when db is absent
const dispatcher = new MemoEventDispatcher({ db: undefined as unknown as SupabaseClient });

dispatcher.start();

const shutdown = async () => {
  await dispatcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
