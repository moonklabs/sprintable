/**
 * story #3845(우패널·주 액션, 페드루 PO 확定 2026-09-14 08:26Z) — 순수 판정 함수만(fetch 0,
 * derive-work-list.ts와 동일 분리 원칙: 파생 로직은 렌더와 떼어 테스트한다).
 *
 * 정본 소스: today_service.py::_needs_me_from_gate_inbox의 `is_signature = gate_type ==
 * 'external_publish' or risk_grade == 'high'`(derive-work-list.ts stateFromInboxItem과
 * 동일 SSOT 판정, 3831 판정과 동형) — 「승인하고 서명」 라벨도 정확히 같은 조건을 재사용한다
 * (별도 새 규칙을 만들지 않는다 — 「서명 대기」 상태와 「승인하고 서명」 버튼이 다른 조건이면
 * 그 자체가 사용자에게 거짓말이 된다).
 */

const EXTERNAL_PUBLISH_GATE_TYPE = 'external_publish';

/** GET /api/v2/gates 응답(GateResponse)의 이 파일이 쓰는 부분집합만. */
export interface WorkListGate {
  id: string;
  gate_type: string;
  risk_grade: 'low' | 'high' | null;
  status: string;
  work_item_id: string;
  work_item_type: string;
}

export type PrimaryActionLabelKey = 'actionApprove' | 'actionApproveAndSign';

/** ⭐뮤테이션 표적 — «승인」/«승인하고 서명」 갈림 자체가 이 함수 하나다. */
export function primaryActionLabelKey(gate: Pick<WorkListGate, 'gate_type' | 'risk_grade'>): PrimaryActionLabelKey {
  const isSignature = gate.gate_type === EXTERNAL_PUBLISH_GATE_TYPE || gate.risk_grade === 'high';
  return isSignature ? 'actionApproveAndSign' : 'actionApprove';
}

/** 위험 pill+문장은 risk_grade가 실제로 있을 때만(gate_type/risk에서만 — PO 明示, 없으면
 * 렌더 0이지 placeholder가 아니다). */
export function riskSentenceKey(gate: Pick<WorkListGate, 'risk_grade'>): 'riskSentenceHigh' | 'riskSentenceLow' | null {
  if (gate.risk_grade === 'high') return 'riskSentenceHigh';
  if (gate.risk_grade === 'low') return 'riskSentenceLow';
  return null;
}

export function riskBadgeVariant(gate: Pick<WorkListGate, 'risk_grade'>): 'destructive' | 'warning' | null {
  if (gate.risk_grade === 'high') return 'destructive';
  if (gate.risk_grade === 'low') return 'warning';
  return null;
}

/** story #3845 — 「답하기」는 conversation_id가 있을 때만(없으면 비노출). GateResponse에
 * conversation_id 필드 자체가 없다(실측 — backend/app/routers/gates.py GateResponse
 * 전수 확認, target_conversation_id는 toss 요청 body에만 존재하는 별개 값). HitlRequestResponse
 * 에도 없다(backend/app/schemas/hitl.py 실측). 그래서 이 함수는 지금 항상 null을 낸다 —
 * 지어내지 않는다. BE가 이 필드를 실으면(별 카드) 이 함수 하나만 고치면 된다(SSOT 1곳).
 */
export function gateConversationId(_gate: unknown): string | null {
  return null;
}
