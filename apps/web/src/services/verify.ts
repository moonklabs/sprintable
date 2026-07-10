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
