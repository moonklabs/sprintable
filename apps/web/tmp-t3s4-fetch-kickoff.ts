import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  const { data: memo } = await supabase
    .from('memos')
    .select('title, content')
    .eq('id', '7dae1917-63dc-45fd-9dc6-fb4a6ba6ce8a')
    .single();

  console.log('=== KICKOFF MEMO ===');
  console.log(memo?.title);
  console.log(memo?.content);

  const { data: story } = await supabase
    .from('stories')
    .select('title, description, status')
    .eq('id', 'ebea5953-6284-4745-b14b-fb11438138a2')
    .single();

  console.log('\n=== STORY ===');
  console.log(story?.title, '|', story?.status);
  console.log(story?.description);
}

main().catch(console.error);
