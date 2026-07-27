/**
 * E-VERIFY V0 — 신뢰 표면(trust surface) FE 타입. BE 계약(S1/S2, PR #1994/#1995) 그대로 미러.
 * `GET /api/v2/evidence?work_item_id={id}&work_item_type=story|task` 응답 — 재조립 없이 서버 shape 그대로 소비.
 */

export type EvidenceType = 'url' | 'file' | 'pr' | 'deploy' | 'metric' | 'report' | 'gate_approval';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  ref: string;
  source: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  org_id: string;
  work_item_id: string;
  work_item_type: 'story' | 'task';
}

/**
 * E-VERIFY P0-04 — claimed-vs-verified-spec-handoff §3 BE 계약(PR #2069) 미러. `has_evidence`
 * (1 boolean, self-report와 human-verified를 뭉갬)를 대체하는 2신호 — story/task 응답에 그대로
 * 동봉. null=미측정(0건), false는 오지 않음(BE 계약).
 */
export interface TrustSignal {
  self_reported?: boolean | null;
  human_verified?: boolean | null;
  human_verified_by?: string | null;
  human_verified_at?: string | null;
}

export type TrustStage = 'claimed' | 'verified' | null;

/**
 * claimed-vs-verified-spec-handoff §3 파생 규칙 그대로: human_verified→verified(green)·
 * self_reported & !human_verified→claimed(amber)·!self_reported→무표시(null, D-03 완료 기준).
 */
export function deriveTrustStage(signal: TrustSignal): TrustStage {
  if (signal.human_verified) return 'verified';
  if (signal.self_reported) return 'claimed';
  return null;
}

/**
 * P0-04 — trust-pipeline-minimal-decision(doc) 결정: 6레인 대시보드 기각·in-flight 전용 칩만
 * 채택. done(주장됨/검증됨)엔 칩 0(TrustSeal이 담당·중복 금지). Queued/Running/범위이탈은
 * BE 신호 자체가 없어(AgentRun story_id 필터 미착지·범위 스키마 무) 렌더 안 함(no-fiction).
 */
export type InFlightTrustChip = 'needs_input' | 'merge_ready' | null;

interface ChipGate {
  gate_type: string;
  status: string;
  neutral_facts?: Record<string, unknown> | null;
}

// _ALWAYS_MANUAL_GATE_TYPES(BE gate_service.py) 미러 — 항상 사람 입력 대기.
const NEEDS_INPUT_GATE_TYPES = new Set(['doc_approval', 'loop_decision', 'artifact_canonicalize']);

/**
 * 결정 doc §스펙: Needs-input(gate 3종 pending)→"입력 필요"(amber)·Merge-ready(merge gate+
 * ci_result=pass+pending)→"병합 대기"(green). story.status==='done'이면 항상 무표시.
 */
export function deriveInFlightTrustChip(storyStatus: string, gates: ChipGate[]): InFlightTrustChip {
  if (storyStatus === 'done') return null;
  const pending = gates.filter((g) => g.status === 'pending');
  if (pending.some((g) => g.gate_type === 'merge' && g.neutral_facts?.['ci_result'] === 'pass')) {
    return 'merge_ready';
  }
  if (pending.some((g) => NEEDS_INPUT_GATE_TYPES.has(g.gate_type))) {
    return 'needs_input';
  }
  return null;
}
