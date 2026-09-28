import { notFound } from 'next/navigation';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { ChatV3Screen } from '@/components/chat-v3/chat-v3-screen';

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
 *
 * story #4017 착지 뒤 재정정(2026-09-22) — env 이름 3개를 각자 읽던 임시 readNavV3Flags()
 * (#4004 rebase 시점 임시 패턴)를 readNavV3FlagsFromEnv() 한 곳 위임으로 교체(#4004
 * 조건 ①). notFound() 게이트도 같은 flags 객체를 재사용.
 */
export default function ChatV3Page() {
  const flags = readNavV3FlagsFromEnv();
  if (!flags.chatV3Enabled) notFound();

  return <ChatV3Screen flags={flags} />;
}
