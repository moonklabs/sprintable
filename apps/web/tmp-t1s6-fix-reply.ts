import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = 'e440416b-2512-416a-af45-6cf0c0273b2e';
  const myId = '9cac9d96-5474-45f7-941e-787407597b52';

  const content = `REQUEST_CHANGES 3건 수정 완료인. 커밋: **69d073d**

**HIGH 1 — RLS insert 강화**
- \`20260416140000_analytics_events.sql\`: \`with check (true)\` → org_members 멤버십 검증으로 교체
- \`events/route.ts\`: 에이전트(API key, auth.uid()=null) insert는 admin client 경유로 처리해 RLS 우회 없이 정상 동작

**HIGH 2 — 퍼널 조회 admin role 체크 추가**
- \`onboarding-funnel/route.ts\`: \`getAuthContext\` → \`supabase.auth.getUser() + getMyTeamMember\` 패턴 전환
- \`org_members.role in [owner, admin]\` 서버사이드 체크, 미통과 시 403 반환

**MEDIUM — days 파라미터 검증 추가**
- \`ALLOWED_DAYS = ['7', '30', 'all']\` 외 입력 시 400 반환

tsc --noEmit 통과 확인인.`;

  const reply = await service.addReply(kickoffMemoId, content, myId);
  console.log('수정 완료 reply 전송:', reply.id);
}

main().catch(console.error);
