import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // kickoff memo
  const { data: memo } = await supabase
    .from('memos')
    .select('id, title, content, created_at')
    .eq('id', '9a07d9c9-afcc-4a02-b54f-d4502e57018b')
    .single();

  console.log('=== KICKOFF MEMO ===');
  console.log(memo?.title);
  console.log(memo?.content);

  // replies
  const { data: replies } = await supabase
    .from('memo_replies')
    .select('id, content, created_at')
    .eq('memo_id', '9a07d9c9-afcc-4a02-b54f-d4502e57018b')
    .order('created_at', { ascending: true });

  if (replies?.length) {
    console.log('\n=== REPLIES ===');
    for (const r of replies) {
      console.log(`\n--- ${r.created_at} ---`);
      console.log(r.content);
    }
  }
}

main().catch(console.error);
