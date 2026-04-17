import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // Search recent kickoff memos
  const { data: memos } = await supabase
    .from('memos')
    .select('id, title, created_at, memo_type, story_id')
    .eq('memo_type', 'kickoff')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('=== RECENT KICKOFF MEMOS ===');
  for (const m of memos ?? []) {
    console.log(`${m.created_at} | ${m.id} | ${m.title}`);
  }

  // Also search memos with "MCP" or "docs" in title
  const { data: mcpMemos } = await supabase
    .from('memos')
    .select('id, title, created_at, memo_type, story_id')
    .or('title.ilike.%MCP%,title.ilike.%공개%,title.ilike.%S6%')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log('\n=== MCP/S6 MEMOS ===');
  for (const m of mcpMemos ?? []) {
    console.log(`${m.created_at} | ${m.id} | ${m.title}`);
  }
}

main().catch(console.error);
