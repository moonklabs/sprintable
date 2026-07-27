import type { GateItem } from '@/components/kanban/types';

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
