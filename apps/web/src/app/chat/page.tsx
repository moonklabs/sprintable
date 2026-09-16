import { notFound } from 'next/navigation';
import { isChatV3Enabled } from '@/lib/chat-v3';
import { ChatV3Screen } from '@/components/chat-v3/chat-v3-screen';

/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N·FE) — 시안 ②(artifact c707a913)
 * 3단 허브: 스레드 레일 + 대화 열 + 맥락 패널. 기능 플래그 뒤, 옛 `/chats`
 * 무접촉(`(authenticated)` 밖 별도 라우트 그룹 — layout.tsx가 세션 가드만
 * 재구현). 데이터는 기존 대화 API 재사용(새 BE 0).
 */
export default function ChatV3Page() {
  if (!isChatV3Enabled()) notFound();

  return <ChatV3Screen />;
}
