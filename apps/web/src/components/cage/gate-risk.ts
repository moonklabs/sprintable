import type { GateItem } from '@/components/kanban/types';
import type { ProofState } from '@/components/proof-capsule/proof-capsule';

// story #1972(P1a-S4) — 위험도 UX 이원화 활성. BE `risk_grade`(gate_service.derive_risk_grade,
// OrgGatePolicy.posture+gate_type 순수 파생, doc `gate-risk-ux-classification-criteria` §2)를
// 그대로 매핑한다 — FE는 추측/휴리스틱을 두지 않는다(SSOT=BE). risk_grade가 null/undefined인
// 구버전 응답만 'unknown'(보수적 고위험 안전판)으로 폴백.
export type RiskLevel = 'low' | 'high' | 'unknown';

export function deriveRiskLevel(gate: GateItem): RiskLevel {
  return gate.risk_grade ?? 'unknown';
}

// ⭐임시 정책(오르테가군 판정, 2026-07-17): unknown은 "보수적 고위험 취급" — 근거 열람+사유
// 게이팅 강제(GateSignatureApproval). 인라인 원탭 승인은 riskLevel==='low' 확정 시에만 허용.
// 위험도를 모르는 상태에서 저위험 경로(원탭 승인)로 잘못 흘려보내는 것보다, 고위험 취급으로
// 안전 쪽에 서는 게 §1.2 신중 결재 정신에 맞는다 — 오승인 방지가 UX 편의보다 우선.
export function usesSignatureFlow(riskLevel: RiskLevel): boolean {
  return riskLevel !== 'low';
}

// story #2926(P0-F 잔여 fast-follow, 카디르 F2 QA LOW②·2026-08-22) — F1(approval-request-
// card.tsx)·F2(gates/[id]/page.tsx)·F3(approvals-queue.tsx)이 각자 독립적으로 같은 로직
// (pending=amber·approved=green·그 외=red)을 갖고 있던 것을 공유화한다(신규 상태 추가 시
// 3곳 동시수정을 강제하는 안전장치 부재 — 현재는 결과 완전동일이라 안전한 중복이었으나,
// 안전장치로 승격). LOW①(F1↔F2 stateLabel 문구 불일치 — held "보류됨" vs "보류중"·approved
// "승인됨" vs "승인 완료")도 여기서 함께 닫는다: 'cage' 네임스페이스에 신규 통일 키(아래)를
// 두고 3곳 다 이 키로 수렴시킨다(F1의 'chats' 네임스페이스 approvalRequestStatus*·F2/F3의
// queueResolved*/heldBadge/gateDetailStatusPending 등 옛 지역 키는 폐기 대상 — rebase 시
// 3파일 각각에서 이 함수+아래 GATE_STATUS_I18N_KEYS로 교체).
//
// ⚠️로컬 준비 단계(2026-08-22, PO 지시) — F1/F2/F3가 아직 develop에 없어(qa:pass 완료·머지
// 대기) 실제 3파일 교체는 못 한다. 이 파일과 아래 i18n 키만 먼저 짜 두고, F1~F3 머지 후
// 이 브랜치를 rebase하며 3파일의 중복 로직을 이 함수 호출로 교체한다.
export type GateStatusKey = 'gateStatusPending' | 'gateStatusApproved' | 'gateStatusRejected' | 'gateStatusHeld' | 'gateStatusVoided';

const GATE_STATUS_I18N_KEYS: Record<string, GateStatusKey> = {
  pending: 'gateStatusPending',
  approved: 'gateStatusApproved',
  rejected: 'gateStatusRejected',
  held: 'gateStatusHeld',
  voided: 'gateStatusVoided',
};

export interface GateProofStateResult {
  proofState: ProofState;
  /** 'cage' 네임스페이스 t()로 넘길 키. 매핑 안 된 값(신설/희귀 status)은 null — 호출부가
   * gate.status 원문을 그대로 보여준다(지어내지 않음, 기존 3파일의 폴백 관례와 동형). */
  statusKey: GateStatusKey | null;
}

/** attention-queue의 기존 PROOF_STATE 관례(gate_pending→amber) 재사용 — pending=amber(인간
 * 검토 대기)·approved=green·그 외(rejected/held/voided)=red. F1/F2/F3 전부 이 판정이었다
 * (신규 결정 아님, 3중 중복을 단일 함수로 승격한 것뿐). */
export function deriveGateProofState(status: string): GateProofStateResult {
  const proofState: ProofState = status === 'pending' ? 'amber' : status === 'approved' ? 'green' : 'red';
  return { proofState, statusKey: GATE_STATUS_I18N_KEYS[status] ?? null };
}
