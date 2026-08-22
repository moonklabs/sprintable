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
  /** story #2722 — 아티팩트를 근거로 삼은 evidence만 채워짐. artifact_version_id가 null이면
   * 나머지 둘도 null(버전 미상 — 구 데이터 또는 아티팩트 근거 아님). */
  artifact_version_id: string | null;
  artifact_id: string | null;
  artifact_version_number: number | null;
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

const _TERMINAL_GATE_STATUSES = new Set(['approved', 'rejected', 'voided']);

/**
 * story #2893(설계안 §2 A1) — 한 스토리에 merge 게이트가 여러 개(PR마다 1개)일 수 있게 됐다.
 * "이 스토리의 merge 게이트"를 단건으로 보여주는 화면(StoryMergeGate·Workcell Evidence
 * 구획)이 이제 «어느 PR 것을 보여줄지» 골라야 한다 — 옛 `.find(g => g.gate_type==='merge')`
 * (배열의 첫 번째, 삽입순=사실상 무작위)를 대체.
 *
 * 우선순위: ①미종결(pending/auto_passed/held — 지금 사람 눈이 필요한 것)이 종결(approved/
 * rejected/voided)보다 우선 ②동순위 중엔 pr_number가 큰 쪽(가장 최근 열린 PR으로 근사).
 * pr_number가 없는(레거시/PR 컨텍스트 없음) 게이트는 항상 최하순위(0 취급, 실 PR 정보가
 * 있는 쪽을 우선 — 지어내지 않되 있으면 쓴다).
 */
export function pickRelevantMergeGate<G extends { gate_type: string; status: string; pr_number?: number | null }>(
  gates: G[],
): G | undefined {
  const mergeGates = gates.filter((g) => g.gate_type === 'merge');
  if (mergeGates.length === 0) return undefined;
  const sorted = [...mergeGates].sort((a, b) => {
    const aOpen = _TERMINAL_GATE_STATUSES.has(a.status) ? 0 : 1;
    const bOpen = _TERMINAL_GATE_STATUSES.has(b.status) ? 0 : 1;
    if (aOpen !== bOpen) return bOpen - aOpen; // 미종결 먼저.
    return (b.pr_number ?? 0) - (a.pr_number ?? 0); // 큰 pr_number(최근 PR) 먼저.
  });
  return sorted[0];
}
