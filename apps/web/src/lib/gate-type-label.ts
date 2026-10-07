// story #3565(유나 §17-24 전수·페드루 PO 確定 2026-09-06) — gate_type → 사람 낱말
// 공용 헬퍼. 원래 Command Center(dashboard/command-center/derive-action-zone.ts)
// 안에만 있던 매핑을 여기로 옮겨 결재함 카드(inbox/approvals-queue.tsx)·게이트
// 상세(app/(authenticated)/gates/[id]/page.tsx)도 같은 표를 탄다 — 그 두 자리는
// 이 매핑 자체가 없어 `gate.gate_type` 원시값(예: "external_publish")을 배지에
// 그대로 찍고 있었다(더 나쁜 증상 — 일반 "게이트"보다도 못한 노출).
//
// ⛔이 집합은 BE 「한 곳」에 안 산다(페드루 PO 재실측 2026-09-06 — #3565 리뷰 前
// 주석의 "두 곳"도 이미 부정확했다): GATE_TYPES(backend/app/models/hitl_config.py)·
// doc_approval(backend/app/services/doc.py)·loop_decision·artifact_canonicalize·
// hypothesis_outcome_confirm(backend/app/services/gate_service.py·
// backend/app/services/hypothesis_outcome_confirm.py)·artifact_canonicalize가
// 또(backend/app/routers/gates.py)에도 나온다 — 넷 이상의 파일에 흩어져 있고,
// 앞으로도 늘어날 수 있다. 줄번호는 리팩터 한 번에 죽는 정보라 파일 경로만
// 남긴다(story #3560, 페드루 PO 지적 2026-09-06). 새 gate_type을 여기 추가할
// 땐 특정 파일 목록을 믿지 말고 backend 전체에서 `gate_type=` 리터럴을 grep해
// 실제로 쓰이는 값을 확認한다.
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
  // support_escalation_review — backend/app/routers/support_gateway_token.py가
  // 생성, backend/app/services/gate_service.py의 _ALWAYS_MANUAL_GATE_TYPES에
  // 있어 항상 수동(story #3263). 페드루 PO 재확認(2026-09-06 — 최초 grep 0건은
  // 로컬 클론이 옛 브랜치에 멈춰 있던 PO 쪽 오류, origin/develop 실물엔 있음).
  support_escalation_review: 'ccGateTypeSupportEscalationReview',
  // story #3560(페드루 PO 確定 2026-09-06) — 제작 작업대 컨셉·구조 승인. 생성=
  // backend/app/routers/docs.py::POST /docs/{id}/concept-approval. `qa`로
  // 흉내내지 않는다(다른 메커니즘=다른 낱말) — doc_approval(시스템전용)과도 별개.
  concept_approval: 'ccGateTypeConceptApproval',
  // story #3806(Phase3·3-2 PR5, 유나 §절 2026-09-11) — 「홍보」(Meta 한국어 UI
  // 관례, en "Boost"). backend/app/services/gate_service.py::create_gate가
  // gate_type="ads_boost"로 생성(PR2), _ALWAYS_MANUAL_GATE_TYPES에도 등재(PR3
  // 워커 fix 시점 확認 — 실제 지출이 걸려 external_publish보다 강한 사유).
  ads_boost: 'ccGateTypeAdsBoost',
  // story #4044(E-RECIPE-1 ①) — 레시피 ⓒ 실탄(예산) 게이트. backend/app/services/
  // recipe_gate_hooks.py가 gate_type="generation_budget"으로 생성. #4072 前까진
  // GateResponse에 sealed_estimated_cost_minor 자체가 없어 값도 못 봤지만(BE fix),
  // 라벨도 이 표에 없어 배지가 일반 "게이트"로 떨어지고 있었다 — 같이 등재.
  generation_budget: 'ccGateTypeGenerationBudget',
  // story #4175 — 뉴스레터 발송 승인(services/newsletter_send.py, 레시피 발송 단계·사람 API 공용).
  // 뉴스레터 프리셋이 이 게이트를 결재함·채팅 카드에 올리므로 «게이트» 폴백 대신 이름을 준다.
  newsletter_send: 'ccGateTypeNewsletterSend',
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

// story #4558(유나 AC0 정본 2026-10-07 · PO 10:19Z) — 게이트 머리 눈썹 글(proof capsule `claimLabel`)은 게이트가
// «무엇을 묻는가»로 세 묶음: 완료 주장(에이전트가 «했다»고 말함) · 판단 요청(에이전트가 «어떻게 할지» 물음) ·
// 진행 승인(이대로 진행할지 사람이 정함). 예전엔 기본값이 늘 «에이전트 주장 · 완료했다고 말해요»라 판단 요청
// 게이트(agent_decision_request)에도 «완료했다고 말해요»가 떴다 — 묻는 것을 주장으로 읽게 하는 틀린 낱말.
// 맵 밖 종류는 «진행 승인» 묶음으로 — 모르는 것을 «완료»라고 단정하지 않는다(정본 §2).
// ⛔종류 집합은 위 GATE_TYPE_LABEL_KEYS와 같은 16종 — 새 gate_type을 저 표에 더하면 여기도 한 묶음에 넣는다
// (gate-type-label.test.ts가 두 표의 키 집합이 같은지 고정).
export type GateClaimGroup = 'claim' | 'decision_request' | 'go_ahead';

export const GATE_CLAIM_GROUPS: Record<string, GateClaimGroup> = {
  qa: 'claim',
  pr_review: 'claim',
  merge: 'claim',
  doc_approval: 'claim',
  concept_approval: 'claim',
  artifact_canonicalize: 'claim',
  agent_decision_request: 'decision_request',
  loop_decision: 'decision_request',
  hypothesis_outcome_confirm: 'decision_request',
  support_escalation_review: 'decision_request',
  external_publish: 'go_ahead',
  newsletter_send: 'go_ahead',
  ads_boost: 'go_ahead',
  generation_budget: 'go_ahead',
  deploy: 'go_ahead',
  workflow_config_publish: 'go_ahead',
};

/** gate_type → 눈썹 묶음. 맵 밖(미래 확장·오타)은 «진행 승인»(완료라고 단정하지 않는 쪽). */
export function gateClaimGroup(gateType: string | null | undefined): GateClaimGroup {
  return (gateType ? GATE_CLAIM_GROUPS[gateType] : undefined) ?? 'go_ahead';
}

/**
 * gate_type → 눈썹 글(완성 문자열). `tProof` = `useTranslations('proofCapsule')`. external_publish만 «발행 승인 · …»(story #4336
 * 낱말 그대로), 나머지 진행 승인 묶음은 «진행 승인 · 이대로 진행할지 결정해요». 키는 여기 리터럴로만 부른다(gateTypeLabel과 같은 꼴 —
 * 키 문자열을 돌려주면 dead-key 가드가 소비처를 못 찾는다).
 */
export function gateClaimLabel(tProof: (key: string) => string, gateType: string | null | undefined): string {
  if (gateType === 'external_publish') return tProof('claim.publishApprovalLabel');
  const group = gateClaimGroup(gateType);
  if (group === 'claim') return tProof('claim.label');
  if (group === 'decision_request') return tProof('claim.decisionRequestLabel');
  return tProof('claim.goAheadLabel');
}
