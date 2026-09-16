import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';

/**
 * story #3972(E-UX-OVERHAUL·「대화」 구현 2/N) — `/chat`도 `/today`(story #3962)와
 * 같은 패턴: `(authenticated)` 레이아웃 밖 별도 라우트 그룹이라(옛 `/chats`·
 * `ChatListView`·`DashboardShell` 무접촉) 그 레이아웃이 도맡던 세션 가드를 여기서
 * 다시 세운다 — 세션 존재 확認 1줄만, 무거운 `/me`+`/memberships`+`/organizations`
 * 3콜은 안 가져온다(새 기전 0).
 */
export default async function ChatV3Layout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const currentPath = hdrs.get('x-pathname') ?? '/chat';

  const session = await getServerSession();
  if (!session) redirect(buildLoginRedirect(currentPath));

  return <>{children}</>;
}
