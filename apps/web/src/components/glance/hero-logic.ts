import type { ProofState } from '@/components/proof-capsule/proof-capsule';

/**
 * E-GLANCE 2D 재설계(story dee92c96) — hero 파생 순수 로직.
 * ⚠️ 데이터 크럭스: 에픽엔 claim/evidence/gate가 없다(story/task 레벨만). hero는 **현재 에픽의
 * 활성 story**를 렌더한다("지금 무엇을 하는가"). 에픽 레벨 발명 절대 0(no-fiction).
 */

/** hero 배선에 필요한 story 최소 형상(`/api/stories?epic_id=` 응답에서). */
export interface HeroStory {
  id: string;
  title: string;
  status: string;
  description: string | null;
  assignee_id: string | null;
  assignee_ids?: string[];
  gates?: { gate_type: string; status: string }[];
}

export interface HeroMember {
  name: string;
  type: string;
}

const PROOF_STATE_BY_STATUS: Record<string, ProofState> = {
  'in-progress': 'blue',
  'in-review': 'amber',
  done: 'green',
};

/**
 * 현재 에픽의 focal 활성 story 선정(spec 락): **in-progress 중 gate-pending 우선, 없으면 첫 in-progress**.
 * in-progress가 하나도 없으면 null → hero 미표시(평온 빈상태·억지 렌더 0).
 */
export function pickFocalStory(stories: HeroStory[]): HeroStory | null {
  const inProgress = stories.filter((s) => s.status === 'in-progress');
  if (inProgress.length === 0) return null;
  const withPendingGate = inProgress.find((s) => s.gates?.some((g) => g.status === 'pending'));
  return withPendingGate ?? inProgress[0]!;
}

/** story.status → ProofState(StoryDetailPanel 정본 매핑). 프루프 표면 없는 상태(backlog 등)는 null. */
export function heroProofState(status: string): ProofState | null {
  return PROOF_STATE_BY_STATUS[status] ?? null;
}

/**
 * 참여자 human/agent 분리 — memberMap[id].type==='agent' 기준(StoryDetailPanel 정본). assignee_ids
 * 우선, 없으면 단일 assignee_id. 매핑 없는 id는 무시.
 */
export function splitParticipants(
  story: HeroStory,
  memberMap: Record<string, HeroMember>,
): { human: HeroMember | null; agent: HeroMember | null } {
  const ids = story.assignee_ids?.length
    ? story.assignee_ids
    : (story.assignee_id ? [story.assignee_id] : []);
  const humanId = ids.find((id) => memberMap[id] && memberMap[id]!.type !== 'agent');
  const agentId = ids.find((id) => memberMap[id]?.type === 'agent');
  return {
    human: humanId ? memberMap[humanId]! : null,
    agent: agentId ? memberMap[agentId]! : null,
  };
}
