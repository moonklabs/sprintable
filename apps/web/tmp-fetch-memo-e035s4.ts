import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const memoId = 'ee008ac3-b8d4-4b7a-a029-fed4ec0351da';

  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const memo = await service.getByIdWithDetails(memoId);

  console.log('=== MEMO ===');
  console.log('ID:', memo.id);
  console.log('Title:', memo.title);
  console.log('Status:', memo.status);
  console.log('Created by:', memo.created_by);
  console.log('Assigned to:', memo.assigned_to);
  console.log('\n=== CONTENT ===');
  console.log(memo.content);
  console.log('\n=== REPLIES ===');
  for (const reply of (memo as any).replies || []) {
    console.log(`\n[${reply.created_at}] ${reply.created_by} (${reply.review_type})`);
    console.log(reply.content);
  }
}

main().catch(console.error);
