import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import StandupPageClient from './standup-client';

interface StandupPageProps {
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story a539c649(S-route-project) S3a — Server Component 경계. proxy.ts(S1)가 resolve 성공 시
 * forwarded request 헤더에 실어 보낸 x-resolved-project-id 를 여기서 읽어 client 로 prop
 * 전달한다(docs/S2와 동일 패턴 — apps/web/src/app/(authenticated)/[ws]/[proj]/docs/layout.tsx
 * 참고). 헤더 부재(=미들웨어가 resolve 실패로 스킵) → 404.
 */
export default async function StandupPage({ params }: StandupPageProps) {
  await params; // ws/proj 자체는 이 페이지 내부에서 안 쓴다(하위 라우트 없음) — 존재 확인만.
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <StandupPageClient projectId={projectId} />;
}
