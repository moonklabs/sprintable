import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('stories')
    .select('id, title, description, status, story_points')
    .eq('id', 'a55660e6-b929-4c78-9d3e-c549b98c42e3')
    .single();

  console.log('title:', data?.title);
  console.log('status:', data?.status);
  console.log('sp:', data?.story_points);
  console.log('\n--- description ---');
  console.log(data?.description);
}

main().catch(console.error);
