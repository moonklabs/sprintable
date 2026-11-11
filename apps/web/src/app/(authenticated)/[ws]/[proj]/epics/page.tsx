import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { GoalsRouteProvider } from '../goals/goals-context';
import { GoalsClient } from '../goals/goals-client';

/**
 * story #2931(2930-I3 분리) — 일감 탭줄의 «목표» 탭 진입. 예전엔 스윔레인 보드 전용 화면이었다.
 * story #4888(UI-5 목표 화면 둘째 조각) — 이제 이 주소도 «목표 화면»(`/goals`)이다: 같은 마스트헤드 · 같은 «보기: 목록 | 스윔레인» 전환, 다만 이 주소는 스윔레인으로 열린다.
 * 주소는 그대로라 옛 북마크 · 알림 링크가 깨지지 않는다(PO). proxy.ts가 실어 보낸 x-resolved-org-id / -project-id와 경로 조각(ws · proj)을 여기서 읽어
 * `/goals`의 layout.tsx가 하던 것과 같은 컨텍스트(GoalsRouteProvider)로 내려준다 — 이 주소는 그 layout 밖이라서.
 */
export default async function EpicsPage({ params }: { params: Promise<{ ws: string; proj: string }> }) {
  const { ws, proj } = await params;
  const h = await headers();
  const orgId = h.get('x-resolved-org-id');
  const projectId = h.get('x-resolved-project-id');
  if (!orgId || !projectId) notFound();

  return (
    <GoalsRouteProvider wsSlug={ws} projSlug={proj} projectId={projectId} orgId={orgId}>
      <GoalsClient projectId={projectId} orgId={orgId} initialView="swimlane" />
    </GoalsRouteProvider>
  );
}
