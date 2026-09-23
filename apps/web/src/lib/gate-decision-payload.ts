/**
 * story #3964 CHANGES-2 선행(페드루 PO ④, 2026-09-16 16:15Z) — 게이트/HITL 결정
 * 호출의 payload 모양을 순수 함수로 뽑아 `inbox/approvals-queue.tsx`(옛 결재함)와
 * `today-v3`(신규)가 같이 쓴다. 두 컴포넌트의 실제 fetch·상태갱신·에러 UI는 각자
 * 그대로 두고(옛 화면 동작·테스트 무변 조건), 「어떤 JSON을 보내는지」만 공유한다.
 */

export interface GateTransitionBody {
  status: 'approved' | 'rejected';
  note: string | null;
  evidence_viewed: boolean;
  reviewed_head_sha: string | null;
  // story #4190 — 레시피 발행 게이트 승인 화면이 그린 초안(카드가 있을 때만 키가 실린다 — 그 밖의 호출 바디는 byte-동일).
  reviewed_draft_id?: string;
  reviewed_draft_version?: number;
}

export function buildGateTransitionBody(params: {
  status: 'approved' | 'rejected';
  note?: string | null;
  evidenceViewed?: boolean;
  reviewedHeadSha?: string | null;
  reviewedDraft?: { id: string; version: number } | null;
}): GateTransitionBody {
  const body: GateTransitionBody = {
    status: params.status,
    note: params.note?.trim() || null,
    evidence_viewed: params.evidenceViewed ?? false,
    reviewed_head_sha: params.reviewedHeadSha ?? null,
  };
  if (params.reviewedDraft) {
    body.reviewed_draft_id = params.reviewedDraft.id;
    body.reviewed_draft_version = params.reviewedDraft.version;
  }
  return body;
}

export interface HitlDecisionBody {
  status: 'approved' | 'rejected';
  response_text?: string | null;
}

export function buildHitlDecisionBody(params: {
  status: 'approved' | 'rejected';
  responseText?: string | null;
}): HitlDecisionBody {
  const body: HitlDecisionBody = { status: params.status };
  // approvals-queue.tsx의 기존 호출은 response_text 자체를 안 보낸다(항상 undefined) —
  // 키를 아예 안 실어야 그 화면의 요청 바디가 byte-동일하게 유지된다.
  if (params.responseText !== undefined) body.response_text = params.responseText;
  return body;
}

/** gates.py의 에러 코드(gate_head_changed·gate_draft_changed·gate_already_resolved) — 문구는
 * 각 소비처가 자기 i18n 네임스페이스로 번역한다(여기선 코드 판별만). story #4190 — gate_draft_changed는
 * «화면이 본 상태와 서버가 어긋남» 부류(head_changed 형제, 유나 확정). */
export type GateTransitionErrorKind = 'head_changed' | 'draft_changed' | 'already_resolved' | 'generic';

export function classifyGateTransitionErrorCode(code: string | undefined | null): GateTransitionErrorKind {
  if (code === 'gate_head_changed') return 'head_changed';
  if (code === 'gate_draft_changed') return 'draft_changed';
  if (code === 'gate_already_resolved') return 'already_resolved';
  return 'generic';
}
