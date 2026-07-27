import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

/**
 * story a539c649(S-route-project) S3a — 존재 가드만(docs/S2와 달리 context provider 불요).
 * mockups는 project 스코핑을 useDashboardContext() 대신 ambient X-Project-Id 헤더 인터셉터
 * (project-context-client.ts)로 처리해왔다 — 그 메커니즘은 경로 이관과 무관하게 그대로
 * 유효하다. 다만 URL의 ws/proj가 실존/접근권 없는 조합이면(S1 미들웨어 resolve 실패로
 * x-resolved-org-id 미주입) ambient project와 무관하게 404 — 그렇지 않으면 URL이 가리키는
 * 것과 무관한 엉뚱한(ambient) project의 mockup이 조용히 렌더될 위험이 있다.
 */
export default async function MockupsLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  if (!h.get('x-resolved-org-id')) notFound();
  return <>{children}</>;
}
