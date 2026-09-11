// story #3806 PR 9(페드루 PO 리뷰 2026-09-11 — 「{member id}님이 처리 — 상태: approved」
// 처럼 gate.status 원시 enum이 그대로 새던 결함) — gate-type-label.ts와 동형 패턴.
// Gate.status는 backend/app/models/gate.py(String(20), server_default="pending")이며
// 실제 쓰이는 값은 app/services/gate_service.py 등에 흩어진 리터럴 grep으로 확認한
// 5종(pending·approved·rejected·held·voided) — 이 화면(gates/[id]/page.tsx)은 그중
// «status !== 'pending'»만 이 표를 탄다.
export const GATE_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'gateStatusPending',
  approved: 'gateStatusApproved',
  rejected: 'gateStatusRejected',
  held: 'gateStatusHeld',
  voided: 'gateStatusVoided',
};

/** gate.status → 사람 낱말. 미등재 값(지어내지 않는다, channelLabel과 동형 폴백)은 원문 그대로. */
export function gateStatusLabel(status: string, t: (key: string) => string): string {
  const key = GATE_STATUS_LABEL_KEYS[status];
  return key ? t(key) : status;
}
