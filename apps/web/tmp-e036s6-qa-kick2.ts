import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kassimId = '0d84cd8f-a795-4e7f-a1c2-6c79e9e60c0b';
  const myId = 'a23307b0-6885-48df-aa67-8d4a3b95dd1c';
  const projectId = 'f3e6ed64-447d-4b1c-ad78-a00cfba715a7';
  const orgId = '54bac162-5c0d-49fa-8e49-85977063a091';

  const content = `까심군, E-036:S6 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/236
**Story**: 9e8adf53-78c9-4192-a52d-8595070c39f7

**변경 범위**:
- \`tools/memos.ts\` 신규: 7개 memos 툴 pmApi 전환 (list_memos, create_memo, send_memo, list_my_memos, read_memo, reply_memo, resolve_memo)
- \`tools/notifications.ts\` 신규: 3개 notifications 툴 pmApi 전환 (check_notifications, mark_notification_read, mark_all_notifications_read)
- \`api/notifications/route.ts\`: Dual Auth 전면화 (getAuthContext + createSupabaseAdminClient, rate limit 추가)
- \`api/notifications/route.test.ts\`: getAuthContext mock 패턴으로 업데이트
- smoke.test.ts: memos 8케이스 + notifications 4케이스 추가, 주 스위트 충돌 해결

**테스트**: 651 tests passed, 타입체크 통과`;

  const memo = await service.create({
    project_id: projectId,
    org_id: orgId,
    title: '[QA 킥] E-036:S6 PR #236',
    content,
    memo_type: 'memo',
    created_by: myId,
    assigned_to: kassimId,
  } as any);

  console.log('QA 킥 메모 전송 완료:', memo.id);
}

main().catch(console.error);
