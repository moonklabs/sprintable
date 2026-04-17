import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';

async function main() {
  const supabase = createSupabaseAdminClient();
  const storyId = '9e8adf53-78c9-4192-a52d-8595070c39f7';

  // E-036:S6 kickoff memo 찾기 — story metadata에서
  const { data: memos, error } = await supabase
    .from('memos')
    .select('id, title, content, created_at, created_by, assigned_to, metadata')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('Error:', error);
    return;
  }

  // story_id 포함된 메모 찾기
  const candidates = (memos ?? []).filter((m: any) => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.story_id === storyId ||
           m.content?.includes(storyId) ||
           m.content?.includes('E-036') ||
           m.content?.includes('S6') ||
           m.content?.includes('memos') ||
           m.content?.includes('notifications');
  });

  console.log('=== RECENT MEMOS ===');
  for (const m of (memos ?? []).slice(0, 10)) {
    console.log(`[${m.created_at}] ${m.id} — ${m.title}`);
  }

  console.log('\n=== S6 CANDIDATES ===');
  for (const m of candidates) {
    console.log(`[${m.created_at}] ${m.id}`);
    console.log('Title:', m.title);
    console.log('Content preview:', m.content?.slice(0, 200));
    console.log('Metadata:', JSON.stringify(m.metadata));
    console.log('---');
  }
}

main().catch(console.error);
