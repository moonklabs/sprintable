import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { WorkListShell } from '@/components/work-list/work-list-shell';

/**
 * story #3844(UX-v3·FE 4·일감 1) — flow/sprints/epics/page.tsx와 동일 진입 패턴(proxy.ts가
 * 실어 보낸 x-resolved-project-id를 client에 전달). 워크스페이스 «뷰» 4번째 탭.
 */
export default async function WorkListPage() {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <WorkListShell projectId={projectId} />;
}
