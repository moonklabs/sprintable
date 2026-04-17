import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data: replies } = await supabase
    .from('memo_replies')
    .select('id, content, created_by, created_at')
    .eq('memo_id', 'ae6c0c81-3067-47ad-a5cc-83b9328db98e')
    .order('created_at', { ascending: true });

  for (const r of replies ?? []) {
    console.log(`\n--- ${r.created_at} (${r.created_by}) ---`);
    console.log(r.content);
  }
}

main().catch(console.error);
