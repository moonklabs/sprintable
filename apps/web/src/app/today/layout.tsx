import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';

/**
 * story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — `/today`는 (authenticated) 레이아웃
 * 밖의 별도 라우트 그룹이라(기존 nav·DashboardShell 무접촉) 그 레이아웃이 지금까지
 * 도맡던 세션 가드를 여기서 다시 세운다(페드루 PO 조건 1, 2026-09-16 15:36Z — 「셸만
 * 빼고 가드는 유지」). `/me`·`/me/memberships`·`/organizations` 3콜과 DashboardShell은
 * 이 라우트에 필요 없어(사이드바·조직 스위처 자체를 그 컴포넌트가 안 쓴다) 그대로
 * 안 가져온다 — 세션 존재 확認 1줄만.
 */
export default async function TodayV3Layout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const currentPath = hdrs.get('x-pathname') ?? '/today';

  const session = await getServerSession();
  if (!session) redirect(buildLoginRedirect(currentPath));

  return <>{children}</>;
}
