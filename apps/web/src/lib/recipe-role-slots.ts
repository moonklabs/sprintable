// story #4046(E-RECIPE-1 ①) — 레시피(사이클형 EventDefinition) stage_metadata를 "역할 슬롯"
// 단위로 묶고 되펴는 순수 함수. 마케팅 레시피 1호(#4039 seed, preset.marketing.video_production)
// 실측 기준: stage_metadata[stage].role 값 자체가 "디렉터"/"크리에이터"/"발행자" 리터럴이고,
// stage 9개가 이 3개 role 라벨로만 갈린다 — role은 서버 데이터(recipe 저자가 적는 자유
// 문자열)이지 FE가 아는 고정 enum이 아니므로, 이 모듈은 role 라벨을 하드코딩하지 않고
// stage_metadata가 실제로 담은 값 그대로 그룹 키로 쓴다(recipe-role-mapping-fields.tsx가
// `meta?.role ?? stage`로 라벨을 그대로 렌더하는 기존 관례와 동형 — 새 taxonomy 발명 안 함).
//
// "연산"(모델 임대) 슬롯은 이 그룹핑에 안 걸린다 — #4039 PR 설계정정 그대로: 연산은 org
// member가 아니라 커넥터/모델이라 recipe_role_bindings(TeamMember.id 매핑) 대상이 아니고,
// stage_metadata[stage].capability로만 선언된다(예: live_generation.capability.kind=
// "generate"). 이 모듈은 role 그룹핑과 별개로 stagesWithCapability()로 그 정보를 노출한다 —
// 두 축(role=누가 담당·capability=무슨 인프라가 필요)을 섞지 않는다(같은 stage가 둘 다 가질
// 수 있다 — 위 live_generation 예시가 role="디렉터"+capability.kind="generate" 동시 보유).

// story #3316 SSOT(EventDefinitionResponse['stage_metadata'], loop-create-dialog.tsx)와
// 구조적으로 호환되게 optional 필드를 그대로 맞춘다 — import는 안 한다(lib/는 components/에
// 의존하지 않는 방향 관례, 이 파일은 컴포넌트 레이어 밖에서도 재사용 가능해야 한다). TS
// structural typing이라 호출부는 캐스팅 없이 EventDefinitionResponse['stage_metadata']를
// 그대로 넘길 수 있다.
export interface RecipeStageMeta {
  role?: string;
  action?: string;
  gate?: { type?: string; approver?: string };
  capability?: { kind?: string; connector_key?: string };
}

export type RecipeStageMetadata = Record<string, RecipeStageMeta>;

/** stage_metadata를 role 라벨별로 묶는다 — role이 없는(신호형/측정형 정의의 빈 stage_metadata
 * 등) stage는 결과에서 빠진다. 순서는 stage_metadata의 키 순서(Object.entries, 삽입 순서 =
 * DB에 저장된 JSON 순서 = payload_schema.stage.enum과 보통 일치)를 그대로 따른다. */
export function groupStagesByRole(stageMetadata: RecipeStageMetadata): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const [stage, meta] of Object.entries(stageMetadata)) {
    const role = meta?.role;
    if (!role) continue;
    (groups[role] ??= []).push(stage);
  }
  return groups;
}

/** role 라벨 → 담당자(team member id) 선택을 그 role에 속한 모든 stage로 펼쳐
 * POST /events/definitions/{id}/apply의 role_mapping(Record<stage, teamMemberId>) 바디를
 * 만든다. capability-only 슬롯(연산)은 groupStagesByRole 자체가 안 뽑으므로 selections에
 * 그 키를 줘도 자연히 무시된다(펼칠 stage가 없음) — 별도 예외 처리 불요. */
export function expandRoleSlotBindings(
  stageMetadata: RecipeStageMetadata,
  selections: Record<string, string>,
): Record<string, string> {
  const groups = groupStagesByRole(stageMetadata);
  const roleMapping: Record<string, string> = {};
  for (const [role, memberId] of Object.entries(selections)) {
    if (!memberId) continue;
    const stages = groups[role];
    if (!stages) continue;
    for (const stage of stages) roleMapping[stage] = memberId;
  }
  return roleMapping;
}

export interface RecipeCapabilityStage {
  stage: string;
  role: string | null;
  capability: { kind?: string; connector_key?: string };
}

/** capability를 선언한 stage 전부(연산·발행 등 인프라/커넥터 필요 자리) — role 유무와 무관하게
 * 노출한다(위 docstring 그대로 role과 capability는 독립 축). UI가 "이 단계는 ~ 커넥터가
 * 필요하다" 같은 정보 배지를 그릴 때 쓴다. 바인딩 대상이 아니므로 team member id를 받지
 * 않는다 — apply_recipe_role_bindings 경로 밖(정보 전용). */
export function stagesWithCapability(stageMetadata: RecipeStageMetadata): RecipeCapabilityStage[] {
  const out: RecipeCapabilityStage[] = [];
  for (const [stage, meta] of Object.entries(stageMetadata)) {
    if (!meta?.capability) continue;
    out.push({ stage, role: meta.role ?? null, capability: meta.capability });
  }
  return out;
}

/** 레시피 key의 둘째 세그먼트(preset.{domain}.{slug})로 도메인을 뽑는다 — #4039 PR
 * docstring이 명시한 그 축("FE 갈러리 필터는 key.split('.')[1]로 구분 가능") 그대로.
 * 커스텀(org 커스텀 정의, key가 org.{slug}.* 형태 — event-definer-form.tsx eventKeyPrefixHint
 * 참조)은 "preset."로 시작하지 않으므로 도메인이 없고 null. */
export function recipeKeyDomain(key: string): string | null {
  if (!key.startsWith('preset.')) return null;
  return key.split('.')[1] ?? null;
}
