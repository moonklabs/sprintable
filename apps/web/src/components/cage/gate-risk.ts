import type { GateItem } from '@/components/kanban/types';

// story #1954(P1a-S4) — 위험도(risk) BE 필드는 아직 미존재(gate.py에 risk_level 류 없음).
// "저·고위험=동일 BE 위험도 필드"(AC) 요구는 별도 후속 계약 논의 필요(BE 위험도 스토리 별도
// 등재 예정, 판정 기준은 유나 기획+디디 BE 협의 — 제품 결정 성격). 그때까지 riskLevel은
// 항상 'unknown'으로 렌더되며(추측 배지 금지), 실 필드가 오면 deriveRiskLevel 한 곳만 교체.
export type RiskLevel = 'low' | 'high' | 'unknown';

// TODO(#1970 후속 위험도 스토리): BE 위험도 필드 확定되면 그 필드를 그대로 매핑 — 추측 휴리스틱 금지.
export function deriveRiskLevel(_gate: GateItem): RiskLevel {
  return 'unknown';
}

// ⭐임시 정책(오르테가군 판정, 2026-07-17): unknown은 "보수적 고위험 취급" — 근거 열람+사유
// 게이팅 강제(GateSignatureApproval). 인라인 원탭 승인은 riskLevel==='low' 확정 시에만 허용.
// 위험도를 모르는 상태에서 저위험 경로(원탭 승인)로 잘못 흘려보내는 것보다, 고위험 취급으로
// 안전 쪽에 서는 게 §1.2 신중 결재 정신에 맞는다 — 오승인 방지가 UX 편의보다 우선.
export function usesSignatureFlow(riskLevel: RiskLevel): boolean {
  return riskLevel !== 'low';
}
