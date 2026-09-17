import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerSession } from '@/lib/db/server';
import { buildLoginRedirect } from '@/lib/auth/session-redirect';
import { RealtimeProvider } from '@/components/realtime-provider';

/**
 * story #4008(E-UX-OVERHAUL·v3 셸 실시간) — v3 라우트(`/chat`, 추후 `/today`)는
 * PO 조건(2026-09-16 15:36Z 「셸만 빼고 가드는 유지」)으로 `(authenticated)`/
 * `DashboardShell` 밖 얇은 레이아웃인데, 그 결정이 `RealtimeProvider`(SSE
 * `/api/event-stream`)까지 같이 빼버려 v3 화면엔 실시간 갱신이 아예 없었다(AC1
 * 그라운딩·PO 확認 2026-09-17 — 「오늘」도 이 라우트 그룹에 아직 없어 마찬가지로
 * 셸리스: 디디의 「오늘 = 이미 셸 콜 있음」 실측은 legacy `/org-briefing` 폴백
 * 화면을 짚은 것으로 PO가 정정).
 *
 * `DashboardShell`이 하던 무거운 호출(`/me/memberships`·`/organizations`·
 * 사이드바·조직 스위처)은 그대로 안 가져온다 — `RealtimeProvider`가 필요로 하는
 * 건 `currentTeamMemberId` 문자열 하나뿐(realtime-provider.tsx 확認 — 그 값만
 * 있으면 자기완결적, 다른 ancestor context 요구 0)이라 가벼운 `/api/v2/me` 1콜로
 * 그것만 공급한다.
 *
 * v3 공용 그룹 레이아웃 1곳(AC7)에 공급자를 달아, v3 화면 사이 이동(`/chat`↔
 * `/today`)에도 이 레이아웃이 안 재마운트되는 한 SSE 연결이 유지된다(재연결
 * 폭주 0).
 *
 * `/me` 조회 실패는 `(authenticated)/layout.tsx`처럼 throw하지 않는다 — 거긴
 * org/project 컨텍스트가 렌더 자체에 필수라 실패를 숨기면 안 되지만, 여기선
 * 「실시간 갱신이 잠깐 안 됨」 정도의 열화(RealtimeProvider가 currentTeamMemberId
 * undefined를 그냥 받아 SSE를 안 여는 것으로 이미 설계돼 있다)라 화면 자체를
 * 막을 이유가 없다 — fail-open.
 */
export default async function V3Layout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  const currentPath = hdrs.get('x-pathname') ?? '';

  const session = await getServerSession();
  if (!session) redirect(buildLoginRedirect(currentPath));

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const meRes = await fetch(`${fastapiUrl}/api/v2/me`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store',
  }).catch(() => null);
  const me = meRes?.ok ? ((await meRes.json()) as { id?: string } | null) : null;

  return <RealtimeProvider currentTeamMemberId={me?.id}>{children}</RealtimeProvider>;
}
