import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  const { data: memo } = await supabase
    .from('memos')
    .select('title, content')
    .eq('id', '9c28e3f3-e161-4d3c-90d4-ab4df062d28c')
    .single();

  console.log('=== KICKOFF MEMO ===');
  console.log(memo?.title);
  console.log(memo?.content);

  const { data: story } = await supabase
    .from('stories')
    .select('title, description, status')
    .eq('id', '2e024a6a-0991-48ae-a643-791031dfb8c4')
    .single();

  console.log('\n=== STORY ===');
  console.log(story?.title, '|', story?.status);
  console.log(story?.description);
}

main().catch(console.error);
