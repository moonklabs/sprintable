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
