import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data: replies } = await supabase
    .from('memo_replies')
    .select('id, content, created_by, created_at')
    .eq('memo_id', '7dae1917-63dc-45fd-9dc6-fb4a6ba6ce8a')
    .order('created_at', { ascending: true });

  const last = (replies ?? []).slice(-2);
  for (const r of last) {
    console.log(`\n--- ${r.created_at} (${r.created_by}) ---`);
    console.log(r.content);
  }
}

main().catch(console.error);
