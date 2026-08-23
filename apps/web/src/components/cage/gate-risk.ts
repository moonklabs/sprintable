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
// 두고 F1/F2가 이 키로 수렴한다(F1의 'chats' 네임스페이스 approvalRequestStatusPending·
// F2의 queueResolved*/heldBadge/gateDetailStatusPending 지역 키는 폐기 완료).
//
// F3(approvals-queue.tsx)의 row-density 클릭스루 분기는 stateLabel만 이 통일 키로 맞추고
// proofState는 의도적으로 amber 고정 유지 — 그 분기는 !resolved만 타 gate.status가 실질
// pending/held뿐이고, held도 "아직 조치 대기" 의미라 F1/F2가 held를 종결취급(red)하는 문맥과
// 다르다(색은 갈리지만 문구는 같은 개념이라 통일). F1~F3 머지(2026-08-22) 후 이 브랜치를
// rebase해 3파일 모두 실제 배선 완료.
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

// story #2950 슬라이스②(PO 설계안 승인, doc gate-risk-real-discriminator-design-2950 §3/§7)
// — risk_grade 칩(변별 0)을 대체하는 «관찰 사실 그대로 노출». 판정/재분류 없음 — BE
// neutral_facts.diff_size/touches_migration이 있으면 그대로 보이고, 없으면(관찰 실패·이
// gate_type엔 파일-diff 개념 자체가 없음 등) 지어내지 않고 null(호출부가 아예 렌더 안 함).
export interface DiffFacts {
  fileCount: number;
  touchesMigration: boolean;
}

export function deriveDiffFacts(gate: GateItem): DiffFacts | null {
  const fileCount = gate.neutral_facts?.['diff_size'];
  if (typeof fileCount !== 'number') return null;
  const touchesMigration = gate.neutral_facts?.['touches_migration'] === true;
  return { fileCount, touchesMigration };
}
