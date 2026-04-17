import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const memoId = 'e440416b-2512-416a-af45-6cf0c0273b2e';

  const { data: replies, error } = await supabase
    .from('memo_replies')
    .select('id, content, created_by, created_at, review_type')
    .eq('memo_id', memoId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  for (const r of replies ?? []) {
    console.log(`\n--- [${r.review_type ?? 'comment'}] ${r.created_at} (${r.created_by}) ---`);
    console.log(r.content);
  }
}

main().catch(console.error);
