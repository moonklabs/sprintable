// story #3565(유나 §17-24 전수·페드루 PO 確定 2026-09-06) — gate_type → 사람 낱말
// 공용 헬퍼. 원래 Command Center(dashboard/command-center/derive-action-zone.ts)
// 안에만 있던 매핑을 여기로 옮겨 결재함 카드(inbox/approvals-queue.tsx)·게이트
// 상세(app/(authenticated)/gates/[id]/page.tsx)도 같은 표를 탄다 — 그 두 자리는
// 이 매핑 자체가 없어 `gate.gate_type` 원시값(예: "external_publish")을 배지에
// 그대로 찍고 있었다(더 나쁜 증상 — 일반 "게이트"보다도 못한 노출).
//
// ⛔이 집합은 BE 「한 곳」에 안 산다(페드루 PO 재실측 2026-09-06 — #3565 리뷰 前
// 주석의 "두 곳"도 이미 부정확했다): GATE_TYPES(backend/app/models/hitl_config.py)·
// doc_approval(backend/app/services/doc.py의 DOC_GATE_TYPE)·loop_decision·
// artifact_canonicalize(backend/app/services/gate_service.py:317
// _ALWAYS_MANUAL_GATE_TYPES)·hypothesis_outcome_confirm(backend/app/services/
// hypothesis_outcome_confirm.py:26)·artifact_canonicalize가 또(backend/app/
// routers/gates.py:535)에도 나온다 — 넷 이상의 파일에 흩어져 있고, 앞으로도
// 늘어날 수 있다. 새 gate_type을 여기 추가할 땐 특정 파일 목록을 믿지 말고
// backend 전체에서 `gate_type=` 리터럴을 grep해 실제로 쓰이는 값을 확認한다.
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
  // support_escalation_review — backend/app/routers/support_gateway_token.py:199가
  // 생성, backend/app/services/gate_service.py의 _ALWAYS_MANUAL_GATE_TYPES(:334)에
  // 있어 항상 수동(story #3263). 페드루 PO 재확認(2026-09-06 — 최초 grep 0건은
  // 로컬 클론이 옛 브랜치에 멈춰 있던 PO 쪽 오류, origin/develop 실물엔 있음).
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
