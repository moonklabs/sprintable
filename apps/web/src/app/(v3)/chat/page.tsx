import { notFound } from 'next/navigation';
import { isChatV3Enabled } from '@/lib/chat-v3';
import { isTodayV3Enabled } from '@/lib/today-v3';
import { ChatV3Screen } from '@/components/chat-v3/chat-v3-screen';
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
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N·FE) — 시안 ②(artifact c707a913)
 * 3단 허브: 스레드 레일 + 대화 열 + 맥락 패널. 기능 플래그 뒤, 옛 `/chats`
 * 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현). 데이터는 기존 대화 API 재사용(새 BE 0).
 *
 * story #3972 CHANGES(페드루 PO 2026-09-17 01:54Z, 실결함) — 화면 플래그는
 * 각자 켜진다(`CHAT_V3_ENABLED=true`·`TODAY_V3_ENABLED` OFF 조합 가능) — 그
 * 조합에서 「오늘」 링크 3곳(관련·서명·nav)이 그대로 `/today`면 404. 이 서버
 * 컴포넌트에서 한 번 읽어 내려준다(각 하위 컴포넌트가 다시 안 읽는다).
 */
export default function ChatV3Page() {
  if (!isChatV3Enabled()) notFound();

  return <ChatV3Screen flags={readNavV3Flags()} />;
}
