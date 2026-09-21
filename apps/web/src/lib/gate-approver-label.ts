// story #4087(E-RECIPE-1, 유나 design 실측 2026-09-21) — 레시피 상세 게이트 카드
// (recipe-detail-view.tsx)·적용 다이얼로그 디렉터 슬롯(marketing-recipe-apply-dialog.tsx)
// 둘 다 `stage_metadata[stage].gate.approver`(raw 키, 예: "org_owner")를 그대로
// 렌더하고 있었다 — 내부어 0 캐논 위반. gate-type-label.ts(story #3565) 패턴 그대로
// 두 표면이 공유하는 SSOT 한 곳으로 해소한다(두 벌 매핑 금지).
//
// #4083(org 정책 «레시피 게이트 기본 승인자», Phase 3 보류 — 선생님 직접결정 2026-09-21)이
// 착지하면 "정책이 지정한 실 멤버명"이 org_owner 같은 구조적 라벨보다 우선해야 한다 — 그
// 자리를 위해 `policyApproverName`(옵션)을 시그니처에 미리 열어 둔다. #4083이 shelved인
// 지금은 항상 undefined로 호출돼 구조적 라벨(«조직 소유자»)로만 떨어진다(실명 해소는 이
// 카드 범위 밖, PO 판정 그대로).
export const GATE_APPROVER_LABEL_KEYS: Record<string, string> = {
  org_owner: 'recipeGateApproverOrgOwner',
};

/**
 * approver 키(+ 정책이 지정한 실명, 있으면 우선) → 사람 낱말. 미등재 키는 지어내지 않고
 * 중립 문구(«승인자 미지정»)로 — gate-type-label.ts의 "raw 값 폴백 금지" 원칙과 동형.
 */
export function gateApproverLabel(
  t: (key: string) => string,
  approver: string | null | undefined,
  policyApproverName?: string | null,
): string {
  if (policyApproverName) return policyApproverName;
  const key = approver ? GATE_APPROVER_LABEL_KEYS[approver] : undefined;
  return key ? t(key) : t('recipeGateApproverUnknown');
}
