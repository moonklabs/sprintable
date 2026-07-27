import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { ArtifactGalleryView } from '@/components/canvas/artifact-gallery-view';

/**
 * story a539c649(S-route-project) S3a — Server Component 경계(docs/S2와 동일 패턴). proxy.ts
 * (S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸 x-resolved-project-id 를 여기서
 * 읽어 client 로 prop 전달한다. ArtifactGalleryView는 기존에 useDashboardContext()에서 직접
 * projectId를 읽던 걸 prop 수신으로 전환(오르테가군 지적 — storage와 동일 "자식 컴포넌트
 * 소비" 케이스).
 */
export default async function ArtifactsPage() {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <ArtifactGalleryView projectId={projectId} />;
}
