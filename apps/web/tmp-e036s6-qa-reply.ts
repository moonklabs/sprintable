import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = '9cd6a08a-c506-4deb-a6d7-c2e64a213e40';
  const myMemberId = '9cac9d96-5474-45f7-941e-787407597b52';

  // Find Kassim's member ID
  const { data: kassim } = await (supabase as any)
    .from('team_members')
    .select('id, name')
    .ilike('name', '%까심%')
    .single();

  console.log('Kassim:', kassim);

  const content = `[DEV][PR_READY] E-036:S6 구현 완료

**PR**: https://github.com/moonklabs/sprintable/pull/236

**변경 범위**:
- \`tools/memos.ts\` 신규: 7개 memos 툴 pmApi 전환
  - list_memos, create_memo, send_memo, list_my_memos, read_memo, reply_memo, resolve_memo
- \`tools/notifications.ts\` 신규: 3개 notifications 툴 pmApi 전환
  - check_notifications, mark_notification_read, mark_all_notifications_read
- \`api/notifications/route.ts\`: Dual Auth 전면화 (getAuthContext + createSupabaseAdminClient)
- \`api/notifications/route.test.ts\`: getAuthContext mock 패턴으로 업데이트
- smoke.test.ts: memos 8케이스 + notifications 4케이스 추가, 메인 스위트 충돌 해결

**검증**: 651 테스트 통과, 타입체크 통과

@까심 아르야 QA 검수 부탁드리는.`;

  await service.addReply(kickoffMemoId, content, myMemberId, 'comment');
  console.log('QA 요청 답신 전송 완료');
}

main().catch(console.error);
