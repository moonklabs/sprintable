import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // T3:S6 story ID: 5bd2f879-...
  const { data: story } = await supabase
    .from('stories')
    .select('id, title, status')
    .ilike('id', '5bd2f879%')
    .single();

  console.log('=== STORY ===');
  console.log(story);

  // Find kickoff memo for T3:S6
  const { data: memos } = await supabase
    .from('memos')
    .select('id, title, created_at, memo_type')
    .eq('story_id', story?.id ?? '')
    .eq('memo_type', 'kickoff')
    .order('created_at', { ascending: false })
    .limit(3);

  console.log('\n=== KICKOFF MEMOS ===');
  console.log(memos);

  // Also search by title
  const { data: byTitle } = await supabase
    .from('memos')
    .select('id, title, created_at, memo_type, story_id')
    .ilike('title', '%T3%S6%')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('\n=== MEMOS WITH T3:S6 IN TITLE ===');
  console.log(byTitle);
}

main().catch(console.error);
