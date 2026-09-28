import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { HypothesesListShell } from '@/components/hypotheses/hypotheses-list-shell';

/**
 * story #3989(「일감」 흡수 3/N·FE) — work-list/page.tsx와 동일 진입 패턴(proxy.ts가
 * 실어 보낸 x-resolved-project-id를 client에 전달). 「일감」 6번째 탭(WorkspaceFrameTabs).
 */
export default async function HypothesesPage() {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <HypothesesListShell projectId={projectId} />;
}
