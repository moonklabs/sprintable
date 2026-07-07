import { redirect } from 'next/navigation';

interface LegacyAgentDetailPageProps {
  params: Promise<{ id: string }>;
}

/**
 * 에이전트 관리 IA 통일(story d63d3f73) — 상세는 `/agents/[id]`로 이동.
 * 기존 딥링크(인박스·채팅 멘션)가 이 경로를 참조하므로 리다이렉트로 보존.
 */
export default async function LegacyAgentDetailPage({ params }: LegacyAgentDetailPageProps) {
  const { id } = await params;
  redirect(`/agents/${id}`);
}
