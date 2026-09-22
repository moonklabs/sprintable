import { notFound } from 'next/navigation';
import { isConnectRulesV3Enabled } from '@/lib/connect-rules-v3';
import { isTodayV3Enabled } from '@/lib/today-v3';
import { isChatV3Enabled } from '@/lib/chat-v3';
import { ConnectRulesV3Screen } from '@/components/connect-rules-v3/connect-rules-v3-screen';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';

// story #4004 — env 이름 3개를 nav-v3-flags-server.ts(readNavV3FlagsFromEnv) 한 곳
// 으로 모으는 건 story #4017(rebase 시점 develop에 아직 없음)의 scope. #4017 착지 뒤
// 재-onto하며 이 함수를 readNavV3FlagsFromEnv()로 교체(중복 축 발명이 아니라 그
// 파일이 아직 없을 뿐 — today/page.tsx·chat/page.tsx와 동형).
function readNavV3Flags(): NavV3Flags {
  return {
    todayV3Enabled: isTodayV3Enabled(),
    chatV3Enabled: isChatV3Enabled(),
    connectRulesV3Enabled: isConnectRulesV3Enabled(),
  };
}

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N·FE) — 시안 ⑤ 그대로. 기능 플래그 뒤,
 * 기존 nav·화면 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현, 「오늘」#3962·「대화」#3972 선례 동형). 새 BE 0(전부 기존 엔드포인트 소비).
 * A(외부 발행 일시 중지 스위치) 절은 #4363(#3953) 착지 뒤 rebase로 후속 추가 예정 — 이
 * PR엔 없음(AC7).
 *
 * PO CHANGES-8(2026-09-17) — 이 서버 컴포넌트가 「오늘」·「대화」 v3 플래그를 직접 읽어
 * 내려준다(#4004 rebase 시점: 두 헬퍼(`isTodayV3Enabled`/`isChatV3Enabled`)가 이제
 * develop에 있다 — 그대로 재사용, 새 축 0). story #4004 — 목적지·nav 렌더는 공유
 * `NavV3ItemList`(nav-v3-item-list.tsx)로, 이 화면 자신은 목적지 리터럴을 안 가진다.
 */
export default function ConnectRulesV3Page() {
  if (!isConnectRulesV3Enabled()) notFound();

  return <ConnectRulesV3Screen flags={readNavV3Flags()} />;
}
