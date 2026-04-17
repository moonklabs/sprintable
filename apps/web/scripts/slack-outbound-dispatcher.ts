import { createClient } from '@supabase/supabase-js';
import { SlackOutboundDispatcher } from '../src/services/slack-outbound-dispatcher';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const dispatcher = new SlackOutboundDispatcher({
  supabase,
  appUrl: process.env.NEXT_PUBLIC_APP_URL,
});

dispatcher.start();

const shutdown = async () => {
  await dispatcher.stop();
  process.exit(0);
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
