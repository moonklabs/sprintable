/**
 * story #4049(E-RECIPE-1 ①, PO 추가 2026-09-18 — 유나 정정 반영) — 레시피 stage_metadata엔
 * slug+role+action만 담기고 표시 라벨이 없다(#4039 seed 실측). detail/gallery가 그동안
 * slug를 그대로 노출하던 것을 해소한다 — stage-role.ts(story #3773)의 정확히 같은 패턴
 * (고정 lookup table, 미등재는 원시값 그대로 pass-through, 새 기전 발명 0).
 *
 * 라벨 정본 — 유나 홀름 핸드오프(2026-09-18, 별도 스레드 conv=b3193043). 이 slug 집합은
 * video_production 1개 레시피 전용이 아니라 앞으로 나올 preset.marketing.* 레시피 공통
 * 축이라는 게 유나 지침 — 새 마케팅 레시피가 같은 slug를 쓰면 이 테이블이 그대로 커버한다
 * (레시피별 override가 필요해지면 그때 확장, 지금은 발명 안 함). 키 네이밍은 stageRoleLabel*
 * (story #3773)과 동형 camelCase로(유나 권장 그대로).
 */
const STAGE_LABEL_KEYS: Record<string, string> = {
  draft: 'recipeStageLabelDraft',
  concept_confirmed: 'recipeStageLabelConceptConfirmed',
  animatic: 'recipeStageLabelAnimatic',
  structure_passed: 'recipeStageLabelStructurePassed',
  // story #4176(레시피 4호 SNS) — 영상은 예산 게이트를 structure_passed에 걸었지만 구조 단계가 없는
  // 레시피용 공통 축 slug.
  budget_approved: 'recipeStageLabelBudgetApproved',
  live_generation: 'recipeStageLabelLiveGeneration',
  verification: 'recipeStageLabelVerification',
  editing: 'recipeStageLabelEditing',
  pending_approval: 'recipeStageLabelPendingApproval',
  published: 'recipeStageLabelPublished',
  // story #4175 — 뉴스레터 프리셋(preset.marketing.newsletter) 단계. draft·published는 위 값 재사용.
  collect: 'recipeStageLabelCollect',
  review: 'recipeStageLabelReview',
  send_requested: 'recipeStageLabelSendRequested',
  send_checked: 'recipeStageLabelSendChecked',
};

export function recipeStageLabel(stage: string, t: (key: string) => string): string {
  return Object.hasOwn(STAGE_LABEL_KEYS, stage) ? t(STAGE_LABEL_KEYS[stage]!) : stage;
}

// 카디르 QA 대칭 테스트용 — stageRoleLabel의 STAGE_ROLE_PRESET_VALUES와 동형 export 관례.
export const RECIPE_STAGE_LABEL_SLUGS = Object.freeze(Object.keys(STAGE_LABEL_KEYS));
