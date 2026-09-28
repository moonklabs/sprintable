import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';

/**
 * story #3201(activation·절벽 처방) — connect-step "첫 지시 보내기" CTA와 온보딩
 * 체크리스트 "첫 지시…" 항목의 딥링크-부재 폴백이 공유하는 단일 DM 생성 경로(PO 확定
 * 2026-08-29: 제3의 경로 발명 금지). `POST /api/conversations`는 always-new(EF-S2/
 * db75ecd0) — 호출할 때마다 신규 DM 1개를 만든다, get-or-create 아님.
 *
 * agentId 미지정 시(체크리스트 폴백 경로 — connect-step은 항상 agentId를 안다) 프로젝트의
 * 첫 agent를 조회해 대상으로 삼는다.
 */
export async function createFirstInstructionConversation(
  projectId: string,
  agentId?: string | null,
): Promise<string | null> {
  let targetAgentId = agentId ?? undefined;
  if (!targetAgentId) {
    const res = await fetchWithAuth(`/api/team-members?project_id=${projectId}&type=agent`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { id: string; runtime_type?: string | null }[] };
    // story #3994 — 「시스템 발행」이 정렬상 첫 에이전트면 이 폴백이 그리로 첫 DM을
    // 열어 버릴 잠재 결함(연결 대상이 아닌 내부 멤버에게 지시를 보내는 셈이라 아무
    // 반응도 안 옴). 골라내고 그다음 실 에이전트를 쓴다.
    targetAgentId = json.data?.find((a) => !isSystemPublisher(a.runtime_type))?.id;
    if (!targetAgentId) return null;
  }

  const res = await fetchWithAuth('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'dm', participant_ids: [targetAgentId], project_id: projectId }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return data.id ?? null;
}
