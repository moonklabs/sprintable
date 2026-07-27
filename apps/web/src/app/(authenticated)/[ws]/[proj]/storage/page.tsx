import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { StorageView } from '@/components/storage/storage-view';

/**
 * story a539c649(S-route-project) S3b — Server Component 경계(docs/S2·artifacts/S3a와 동일
 * 패턴). proxy.ts(S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸
 * x-resolved-project-id 를 여기서 읽어 client 로 prop 전달한다. StorageView는 기존에
 * useDashboardContext()에서 직접 projectId를 읽던 걸 prop 수신으로 전환(artifacts와 동형
 * "자식 컴포넌트 소비" 케이스, 오르테가군 사전 지적).
 */
export default async function StoragePage() {
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <StorageView projectId={projectId} />;
}
