import { InviteClient } from './invite-client';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveChatsHref } from '@/lib/nav-v3-destinations';

// story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:44Z) — 이 라우트는 원래 그 자체가
// client 컴포넌트라 process.env를 못 읽었다. 실 UI(useSearchParams·useRouter 등)는
// invite-client.tsx로 옮기고, 이 서버 래퍼 한 겹이 목적지를 읽어 prop으로 내려준다.
export default function InvitePage() {
  const chatsHref = resolveChatsHref(readNavV3FlagsFromEnv());
  return <InviteClient chatsHref={chatsHref} />;
}
