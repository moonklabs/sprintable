import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // All recent memos — any type
  const { data: memos } = await supabase
    .from('memos')
    .select('id, title, created_at, memo_type, story_id')
    .order('created_at', { ascending: false })
    .limit(15);

  console.log('=== RECENT 15 MEMOS ===');
  for (const m of memos ?? []) {
    console.log(`${m.created_at?.slice(0, 16)} | ${m.memo_type?.padEnd(15)} | ${m.id} | ${m.title}`);
  }
}

main().catch(console.error);
