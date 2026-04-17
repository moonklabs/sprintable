import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const { data: replies } = await supabase
    .from('memo_replies')
    .select('id, content, created_by, created_at')
    .eq('memo_id', 'f70d8fb6-3557-473d-8131-2829aa1b96db')
    .order('created_at', { ascending: true });

  for (const r of replies ?? []) {
    console.log(`\n--- ${r.created_at} (${r.created_by}) ---`);
    console.log(r.content);
  }
}

main().catch(console.error);
