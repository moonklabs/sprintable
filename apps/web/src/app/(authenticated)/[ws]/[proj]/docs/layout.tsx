import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { DocsClientLayout } from './docs-client-layout';

interface DocsLayoutProps {
  children: React.ReactNode;
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story a539c649(S-route-project) S2 — Server Component 경계. proxy.ts(S1)가 resolve 성공 시
 * forwarded request 헤더에 실어 보낸 x-resolved-org-id/-project-id 를 여기서 읽어 client 트리로
 * prop 전달한다. `useDashboardContext()`(전역 "현재 프로젝트")가 아니라 **URL 이 가리키는 실제
 * project** 를 써야 정확하다 — 그래야 #2154(사용자가 대시보드 컨텍스트와 다른 project의 문서
 * URL을 직접 열었을 때 잘못된 project로 재질의되던 레이스)가 구조적으로 재발하지 않는다.
 *
 * 헤더 부재(=미들웨어가 resolve 실패로 스킵) → 404. resolve 자체는 미들웨어가 이미 성공시켰다는
 * 뜻이므로 여기 도달했는데 헤더가 없다는건 org/project 미소속·미존재였다는 뜻.
 */
export default async function DocsLayout({ children, params }: DocsLayoutProps) {
  const { ws, proj } = await params;
  const h = await headers();
  const orgId = h.get('x-resolved-org-id');
  const projectId = h.get('x-resolved-project-id');
  if (!orgId || !projectId) notFound();

  return (
    <DocsClientLayout wsSlug={ws} projSlug={proj} projectId={projectId}>
      {children}
    </DocsClientLayout>
  );
}
