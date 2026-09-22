import { notFound } from 'next/navigation';
import { isTodayV3Enabled } from '@/lib/today-v3';
import { isChatV3Enabled } from '@/lib/chat-v3';
import { TodayV3Screen } from '@/components/today-v3/today-v3-screen';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

// story #4004 — env 이름 3개를 nav-v3-flags-server.ts(readNavV3FlagsFromEnv) 한 곳
// 으로 모으는 건 story #4017(rebase 시점 develop에 아직 없음 — 4004는 4386/4365/
// 4370/4376 착지만 전제로 한다)의 scope. #4017 착지 뒤 재-onto하며 이 함수를
// readNavV3FlagsFromEnv()로 교체(중복 축 발명이 아니라 그 파일이 아직 없을 뿐).
function readNavV3Flags(): NavV3Flags {
  return {
    todayV3Enabled: isTodayV3Enabled(),
    chatV3Enabled: isChatV3Enabled(),
    connectRulesV3Enabled: process.env['CONNECT_RULES_V3_ENABLED'] === 'true',
  };
}

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N·FE) — 시안 ①(artifact d31b9e6d) 그대로:
 * 공통 셸(좌 nav 6 + 상단) + 내 결정 큐 + 진행 中 + 오늘 결과. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션
 * 가드만 재구현). 데이터는 기존 `GET /api/v2/today`(story #3823) 1콜 그대로(자체
 * 집계 0) — `use-today-snapshot.ts`가 org-briefing과 공유하는 그 fetch 하나.
 */
export default function TodayV3Page() {
  if (!isTodayV3Enabled()) notFound();

  return <TodayV3Screen flags={readNavV3Flags()} />;
}
