import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import FlowPageClient from './flow-client';

interface FlowPageProps {
  params: Promise<{ ws: string; proj: string }>;
}

/**
 * story #2224(IA v2.2 §6) — 통합 화면 기본 진입 라우트. board/page.tsx와 같은 패턴(proxy.ts가
 * 실어 보낸 x-resolved-project-id를 읽어 client에 prop 전달) — §7-3에 따라 `/flow`와 `/board`는
 * 같은 URL세그먼트+헤더 스킴을 쓰는 형제 라우트다(중첩 아님).
 */
export default async function FlowPage({ params }: FlowPageProps) {
  const { ws, proj } = await params;
  const h = await headers();
  const projectId = h.get('x-resolved-project-id');
  if (!projectId) notFound();

  return <FlowPageClient projectId={projectId} wsSlug={ws} projSlug={proj} />;
}
