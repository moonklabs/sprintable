import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('stories')
    .select('id,title,description,status')
    .eq('id', '14d28bc4-96ac-428f-9553-13c84c88d946')
    .single();
  console.log('Title:', data?.title);
  console.log('\n=== DESCRIPTION ===');
  console.log(data?.description);
}

main().catch(console.error);
