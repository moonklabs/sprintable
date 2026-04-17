import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const kickoffMemoId = 'e440416b-2512-416a-af45-6cf0c0273b2e'; // T1:S6 킥오프 메모
  const myId = '9cac9d96-5474-45f7-941e-787407597b52'; // 은와추쿠

  const content = `까심군, T1:S6 QA 요청하는.

**PR**: https://github.com/moonklabs/sprintable/pull/280
**Story**: dbc47189 (T1:S6 — 온보딩 퍼널 분석)
**Commit**: ed7e5f7

**변경 범위**:
- \`packages/db/supabase/migrations/20260416140000_analytics_events.sql\`: analytics_events 테이블 신규 (org_id/project_id/event_name/step/metadata + RLS + 인덱스 3개)
- \`apps/web/src/app/api/analytics/events/route.ts\`: POST — onboarding_step_complete 이벤트 기록
- \`apps/web/src/app/api/analytics/onboarding-funnel/route.ts\`: GET ?days=7|30|all — 스텝별 전환율/이탈률 집계
- \`apps/web/src/components/settings/onboarding-funnel-dashboard.tsx\`: 날짜 필터 + stat 카드 + 바 차트 + 최대 이탈 amber 하이라이트
- \`apps/web/src/components/dashboard/quick-start-guide.tsx\`: 스텝 완료 시 analytics 이벤트 발송 (localStorage 중복 방지)
- \`apps/web/src/app/(authenticated)/settings/page.tsx\`: admin 전용 #onboarding-funnel 섹션 추가
- \`messages/en.json / ko.json\`: funnel* i18n 키 10개 추가

**타입체크**: tsc --noEmit 통과`;

  const reply = await service.addReply(kickoffMemoId, content, myId);

  console.log('QA 킥 reply 전송 완료:', reply.id);
}

main().catch(console.error);
