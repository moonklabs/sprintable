import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import BoardPageClient from './board-client';

interface BoardPageProps {
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story a539c649(S-route-project) S3d — Server Component 경계(docs/S2와 동일 패턴). proxy.ts
 * (S1)가 resolve 성공 시 forwarded request 헤더에 실어 보낸 x-resolved-project-id 를 여기서
 * 읽어 client 로 prop 전달한다. board는 이 마이그레이션의 마지막·최고위험 슬라이스(외부
 * 딥링크 실측 ~14곳) — PO 지시로 집중 QA.
 */
export default async function BoardPage({ params }: BoardPageProps) {
  const { ws, proj } = await params;
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <BoardPageClient projectId={projectId} wsSlug={ws} projSlug={proj} />;
}
