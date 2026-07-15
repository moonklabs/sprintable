import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { SprintsClient } from './sprints-client';

/**
 * story a539c649(S-route-project) S3b — Server Component 경계(docs/S2와 동일 패턴). proxy.ts
 * (S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸 x-resolved-org-id/-project-id 를
 * 여기서 읽어 client 로 prop 전달한다.
 */
export default async function SprintsPage() {
  const h = await headers();
  const orgId = h.get('x-resolved-org-id');
  const projectId = h.get('x-resolved-project-id');
  if (!orgId || !projectId) notFound();

  return <SprintsClient projectId={projectId} orgId={orgId} />;
}
