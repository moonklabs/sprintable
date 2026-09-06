// story #3565(유나 §17-24 전수·페드루 PO 確定 2026-09-06) — gate_type → 사람 낱말
// 공용 헬퍼. 원래 Command Center(dashboard/command-center/derive-action-zone.ts)
// 안에만 있던 매핑을 여기로 옮겨 결재함 카드(inbox/approvals-queue.tsx)·게이트
// 상세(app/(authenticated)/gates/[id]/page.tsx)도 같은 표를 탄다 — 그 두 자리는
// 이 매핑 자체가 없어 `gate.gate_type` 원시값(예: "external_publish")을 배지에
// 그대로 찍고 있었다(더 나쁜 증상 — 일반 "게이트"보다도 못한 노출).
//
// ⛔이 집합은 BE에 «한 곳»이 아니라 «두 곳»에 산다(PO 지적 — 값진 함정, 다음
// 사람도 놓치기 쉽다): GATE_TYPES(backend/app/models/hitl_config.py: pr_review·
// qa·merge·deploy·workflow_config_publish·agent_decision_request·
// external_publish) + doc_approval(backend/app/services/doc.py의 DOC_GATE_TYPE,
// hitl_config.py의 GATE_TYPES frozenset에는 없음). 새 gate_type을 여기 추가할
// 땐 두 파일 다 확認한다.
//
export const GATE_TYPE_LABEL_KEYS: Record<string, string> = {
  qa: 'ccGateTypeQa',
  pr_review: 'ccGateTypePrReview',
  merge: 'ccGateTypeMerge',
  deploy: 'ccGateTypeDeploy',
  workflow_config_publish: 'ccGateTypeWorkflowConfigPublish',
  doc_approval: 'ccGateTypeDocApproval',
  external_publish: 'ccGateTypeExternalPublish',
  // story #3565(유나 §17-24 전수 확定 2026-09-06) — 나머지 5유형 등재.
  loop_decision: 'ccGateTypeLoopDecision',
  hypothesis_outcome_confirm: 'ccGateTypeHypothesisOutcomeConfirm',
  artifact_canonicalize: 'ccGateTypeArtifactCanonicalize',
  agent_decision_request: 'ccGateTypeAgentDecisionRequest',
  support_escalation_review: 'ccGateTypeSupportEscalationReview',
};

/**
 * gate_type → i18n 키. 맵에 없는 값(미래 확장·오타 등)은 null — 호출부가 null일 때와
 * «같은 자리»(일반 라벨)로 떨어뜨린다. 원시값을 폴백으로 내보내지 않는다(PO 지적).
 */
export function gateTypeLabelKey(gateType: string | null | undefined): string | null {
  if (!gateType) return null;
  return GATE_TYPE_LABEL_KEYS[gateType] ?? null;
}

/** gate_type → 사람 낱말(완성 문자열). 미등재 값은 일반 "게이트"(ccGateGeneric)로. */
export function gateTypeLabel(t: (key: string) => string, gateType: string | null | undefined): string {
  const key = gateTypeLabelKey(gateType);
  return key ? t(key) : t('ccGateGeneric');
}
