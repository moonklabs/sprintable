import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';

/**
 * story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — `/connect-rules`는 (authenticated)
 * 레이아웃 밖 별도 라우트 그룹(「오늘」#3962·「대화」#3972 선례 동형)이라 세션 가드를 여기서
 * 다시 세운다. 셸(사이드바·조직 스위처)은 이 라우트에 필요 없어 안 가져온다 — 세션 존재
 * 확認 1줄만.
 */
export default async function ConnectRulesV3Layout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const currentPath = hdrs.get('x-pathname') ?? '/connect-rules';

  const session = await getServerSession();
  if (!session) redirect(buildLoginRedirect(currentPath));

  return <>{children}</>;
}
