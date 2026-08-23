import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { EpicSwimlaneBoard } from '@/components/epics/epic-swimlane-board';

/**
 * story #2931(2930-I3 분리) — flow/page.tsx·sprints/page.tsx와 동일 진입 패턴(proxy.ts가
 * 실어 보낸 x-resolved-project-id를 client에 전달). 워크스페이스 «뷰» 3종의 마지막 조각.
 */
export default async function EpicsPage() {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <EpicSwimlaneBoard projectId={projectId} />;
}
