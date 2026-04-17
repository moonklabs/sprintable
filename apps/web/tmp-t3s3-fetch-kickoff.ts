import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  const { data: memo } = await supabase
    .from('memos')
    .select('title, content')
    .eq('id', 'd3eb2db7-4f0b-4256-b440-4ab672fdc073')
    .single();

  console.log('=== KICKOFF MEMO ===');
  console.log(memo?.title);
  console.log(memo?.content);

  const { data: story } = await supabase
    .from('stories')
    .select('title, description, status')
    .eq('id', '1c624587-58fd-479e-9c17-3ce64ca12e53')
    .single();

  console.log('\n=== STORY ===');
  console.log(story?.title, '|', story?.status);
  console.log(story?.description);
}

main().catch(console.error);
