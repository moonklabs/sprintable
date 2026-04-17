import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from('stories')
    .select('*')
    .eq('id', 'c3d6b655-036f-4858-ba5b-5161b1a60ff0')
    .single();

  if (error) throw error;
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
