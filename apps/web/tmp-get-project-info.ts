import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();

  // 킥오프 메모에서 project_id, org_id 가져오기
  const { data: memo } = await supabase
    .from('memos')
    .select('project_id, org_id')
    .eq('id', '9cd6a08a-c506-4deb-a6d7-c2e64a213e40')
    .single();

  console.log('Kickoff memo project_id:', memo?.project_id);
  console.log('Kickoff memo org_id:', memo?.org_id);
}

main().catch(console.error);
