/**
 * Realtime 수신 테스트 스크립트
 *
 * Usage:
 *   SUPABASE_URL=http://localhost:54321 SUPABASE_ANON_KEY=<key> npx tsx scripts/test-realtime.ts
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';

if (!SUPABASE_ANON_KEY) {
  console.error('Error: SUPABASE_ANON_KEY 환경변수 필요');
  console.error('Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... npx tsx scripts/test-realtime.ts');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log(`Connecting to ${SUPABASE_URL}...`);
console.log('Subscribing to INSERT events on public.memos...\n');

const channel = supabase
  .channel('memos-realtime-test')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'memos' },
    (payload) => {
      console.log('✅ INSERT event received:');
      console.log(JSON.stringify(payload.new, null, 2));
      console.log('');
    },
  )
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'memo_replies' },
    (payload) => {
      console.log('✅ REPLY INSERT event received:');
      console.log(JSON.stringify(payload.new, null, 2));
      console.log('');
    },
  )
  .subscribe((status) => {
    console.log(`Channel status: ${status}`);
    if (status === 'SUBSCRIBED') {
      console.log('\n🎧 Listening... (INSERT a memo in another terminal to test)');
      console.log('Press Ctrl+C to stop.\n');
    }
  });

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nUnsubscribing...');
  await supabase.removeChannel(channel);
  process.exit(0);
});
