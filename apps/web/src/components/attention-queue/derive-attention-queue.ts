import type { ProofState } from '@/components/proof-capsule/proof-capsule';
import type { GateItem } from '@/components/kanban/types';

export type AttentionKind = 'verify_fail' | 'decision_needed' | 'blocked' | 'merge_ready';

export interface AttentionActor {
  name: string;
  isAgent: boolean;
}

export interface AttentionQueueItem {
  id: string;
  kind: AttentionKind;
  kindLabel: string;
  proofState: ProofState;
  claim: string;
  actor: AttentionActor | null;
  actionLabel: string;
  actionTone: 'primary' | 'neutral' | 'ready';
  href: string;
  /** 정렬용 epoch ms. 실 타임스탬프가 없는 유형(예: 막힘 — 의존성 엣지엔 시각 필드 없음)은
   * 0으로 정직하게 처리(지어낸 최신순 아님 — 동급 티어 내 안정적 후순위). */
  sortKey: number;
}

export interface AttentionStoryLite {
  id: string;
  title: string;
  assignee_id: string | null;
}

export interface AttentionMember {
  name: string | null;
  type: 'human' | 'agent';
}

export const ATTENTION_KIND_LABEL: Record<AttentionKind, string> = {
  verify_fail: '검증 실패',
  decision_needed: '결정 필요',
  blocked: '막힘',
  merge_ready: '병합 대기',
};

function actorFor(
  story: AttentionStoryLite | undefined,
  membersById: Map<string, AttentionMember>,
): AttentionActor | null {
  if (!story?.assignee_id) return null;
  const m = membersById.get(story.assignee_id);
  if (!m?.name) return null;
  return { name: m.name, isAgent: m.type === 'agent' };
}

function toEpoch(iso: string | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

const PROOF_STATE: Record<AttentionKind, ProofState> = {
  verify_fail: 'amber',
  decision_needed: 'amber',
  blocked: 'amber',
  merge_ready: 'green',
};

/**
 * gate(type=merge)의 neutral_facts.ci_result로 검증실패/병합대기를 분기하고,
 * gate(type=loop_decision, 항상-수동)를 결정필요로 매핑한다. story 제목을 모르는 gate(=
 * storiesById에 없는 work_item_id)는 claim을 지어낼 수 없어 통째로 생략(no-fiction).
 */
export function deriveGateAttentionItems(
  gates: GateItem[],
  storiesById: Map<string, AttentionStoryLite>,
  membersById: Map<string, AttentionMember>,
): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];
  for (const gate of gates) {
    if (gate.work_item_type !== 'story' || gate.status !== 'pending') continue;
    const story = storiesById.get(gate.work_item_id);
    if (!story) continue;
    const actor = actorFor(story, membersById);
    const ciResult = gate.neutral_facts?.['ci_result'];
    const base = { id: `gate-${gate.id}`, actor, href: `/board?story=${story.id}`, sortKey: toEpoch(gate.updated_at) };

    if (gate.gate_type === 'merge' && ciResult === 'fail') {
      items.push({
        ...base, kind: 'verify_fail', kindLabel: ATTENTION_KIND_LABEL.verify_fail,
        proofState: PROOF_STATE.verify_fail, claim: `${story.title} — CI 검증 실패, 재작업 필요`,
        actionLabel: '재작업 지시', actionTone: 'neutral',
      });
    } else if (gate.gate_type === 'merge' && ciResult === 'pass') {
      items.push({
        ...base, kind: 'merge_ready', kindLabel: ATTENTION_KIND_LABEL.merge_ready,
        proofState: PROOF_STATE.merge_ready, claim: `${story.title} — 검증 완료, 병합 대기`,
        actionLabel: '병합', actionTone: 'ready',
      });
    } else if (gate.gate_type === 'loop_decision') {
      items.push({
        ...base, kind: 'decision_needed', kindLabel: ATTENTION_KIND_LABEL.decision_needed,
        proofState: PROOF_STATE.decision_needed, claim: `${story.title} — 방향 결정 필요`,
        actionLabel: '결정', actionTone: 'primary',
      });
    }
  }
  return items;
}

/**
 * 의존성 그래프(dep_type='blocks')에서 파생된 blockedByMap(to_id → from_id[])을 막힘 항목으로.
 * story.status==='held'가 아니라 실 차단 엣지 기반(그라운딩 정정) — story 제목 없으면 생략.
 */
export function deriveBlockedAttentionItems(
  blockedByMap: Record<string, string[]>,
  storiesById: Map<string, AttentionStoryLite>,
  membersById: Map<string, AttentionMember>,
): AttentionQueueItem[] {
  const items: AttentionQueueItem[] = [];
  for (const [storyId, blockers] of Object.entries(blockedByMap)) {
    if (blockers.length === 0) continue;
    const story = storiesById.get(storyId);
    if (!story) continue;
    items.push({
      id: `blocked-${storyId}`,
      kind: 'blocked',
      kindLabel: ATTENTION_KIND_LABEL.blocked,
      proofState: PROOF_STATE.blocked,
      claim: `${story.title} — ${blockers.length}건에 막혀 진행 불가, 조율 필요`,
      actor: actorFor(story, membersById),
      actionLabel: '조율',
      actionTone: 'neutral',
      href: `/board?story=${story.id}`,
      sortKey: 0,
    });
  }
  return items;
}

const KIND_PRIORITY: Record<AttentionKind, number> = {
  verify_fail: 0, decision_needed: 0, blocked: 0, merge_ready: 1,
};

/**
 * 우선순위(amber 3종 > green 1종) 정렬 후 3~7 상한 cap. 미달이어도 억지로 안 채우고(스펙 §4),
 * 초과분은 "흐름" 강등 카운트(overflow)로만 — 별도 fabricated activity 지표 없음.
 */
export function buildAttentionQueue(
  items: AttentionQueueItem[],
  cap = 7,
): { shown: AttentionQueueItem[]; overflow: number } {
  const sorted = [...items].sort((a, b) => {
    const p = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    return p !== 0 ? p : b.sortKey - a.sortKey;
  });
  return { shown: sorted.slice(0, cap), overflow: Math.max(0, sorted.length - cap) };
}
