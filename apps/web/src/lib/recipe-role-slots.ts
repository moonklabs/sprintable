// story #4046(E-RECIPE-1 ①) — 레시피(사이클형 EventDefinition) stage_metadata를 "역할" 단위로
// 묶고 되펴는 순수 함수.
//
// ⚠️PO 判定(2026-09-18, 유나 시안 v1 핸드오프 ③ — story #4046 AC 업데이트, 이 카드 착수 도중
// 반영) — 마케팅 레시피 1호(#4039 seed, preset.marketing.video_production)의 role 라벨 3종
// (디렉터·크리에이터·발행자) 전부를 하나의 role_mapping(=recipe_role_bindings, TeamMember.id
// 바인딩)으로 «넓히지 말 것». 각 role은 서로 다른 메커니즘에 배선된다:
//   · 크리에이터 = role_binding(agent_member_id) — apply_recipe_role_bindings 계약 그대로.
//     이 파일이 다루는 유일한 role_mapping-eligible 축.
//   · 디렉터(사람) = 게이트 승인 주체. stage_metadata[stage].gate.approver("org_owner")가 이미
//     그 주체를 담고 있다 — recipe_role_bindings의 새 바인딩 축이 아니다.
//   · 연산(모델) = 모델/생성 예산 config(generation_budget 축) — member 바인딩 아님.
//   · 발행자 = 발행 채널/타깃(external_publish·채널 커넥션) — member 바인딩 아님(#4419 PR
//     원 docstring은 발행자도 role_binding 대상이라 적었으나 PO가 재판정으로 정정했다 —
//     미르코 seed apply 계약과 맞물리니 인터페이스 확認 후 후속 카드에서 배선, 이 카드는
//     크리에이터 축까지만).
// role 라벨은 recipe 저자가 적는 자유 문자열(고정 enum 아님)이라 구조만 보고 "이 role은
// 바인딩 대상"을 자동 판별할 수 없다 — expandRoleSlotBindings가 bindableRoles 인자를 강제해
// 호출부가 "이 role만 바인딩 대상"을 명시하게 만든다(그냥 문서화가 아니라 시그니처로 강제 —
// #4038 부주의 재발 방지).

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

/** stage_metadata를 role 라벨별로 묶는다(정보 그룹핑 — "이 role이 role_mapping 바인딩
 * 대상"이라는 뜻이 아니다, 그건 expandRoleSlotBindings의 bindableRoles가 별도로 판단한다).
 * role이 없는(신호형/측정형 정의의 빈 stage_metadata 등) stage는 결과에서 빠진다. 순서는
 * stage_metadata의 키 순서(Object.entries, 삽입 순서 = DB에 저장된 JSON 순서 =
 * payload_schema.stage.enum과 보통 일치)를 그대로 따른다. */
export function groupStagesByRole(stageMetadata: RecipeStageMetadata): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const [stage, meta] of Object.entries(stageMetadata)) {
    const role = meta?.role;
    if (!role) continue;
    (groups[role] ??= []).push(stage);
  }
  return groups;
}

/** role 라벨 → 담당자(team member id) 선택 중 `bindableRoles`에 명시된 role만 펼쳐
 * POST /events/definitions/{id}/apply의 role_mapping(Record<stage, teamMemberId>) 바디를
 * 만든다. `bindableRoles`에 없는 role 선택은(예: "디렉터"·"발행자") 조용히 무시한다 — 그
 * role들은 이 함수가 만드는 role_mapping 축이 아닌 다른 메커니즘(게이트 승인 주체·
 * generation_budget·채널 타깃)에 속하기 때문(파일 docstring 참조). 호출부가 실수로 모든
 * role 그룹을 다 넘겨도 이 화이트리스트가 잘못된 바인딩을 막는다. */
export function expandRoleSlotBindings(
  stageMetadata: RecipeStageMetadata,
  bindableRoles: readonly string[],
  selections: Record<string, string>,
): Record<string, string> {
  const groups = groupStagesByRole(stageMetadata);
  const bindableSet = new Set(bindableRoles);
  const roleMapping: Record<string, string> = {};
  for (const [role, memberId] of Object.entries(selections)) {
    if (!memberId || !bindableSet.has(role)) continue;
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
 * 노출한다(role과 capability는 독립 축, 같은 stage가 둘 다 가질 수 있다 — 예:
 * live_generation은 role="디렉터"+capability.kind="generate" 동시 보유). UI가 "이 단계는 ~
 * 커넥터가 필요하다" 같은 정보 배지를 그릴 때 쓴다. 바인딩 대상이 아니므로 team member id를
 * 받지 않는다 — apply_recipe_role_bindings 경로 밖(정보 전용, 연산=generation_budget·
 * 발행=channel_connector_map 각자의 config 화면이 실제 값을 다룬다, 이 함수는 "이 stage가
 * 그 축에 걸린다"만 알려준다). */
export function stagesWithCapability(stageMetadata: RecipeStageMetadata): RecipeCapabilityStage[] {
  const out: RecipeCapabilityStage[] = [];
  for (const [stage, meta] of Object.entries(stageMetadata)) {
    if (!meta?.capability) continue;
    out.push({ stage, role: meta.role ?? null, capability: meta.capability });
  }
  return out;
}

/** 게이트를 선언한 stage 전부 — 사람 승인 주체(approver)가 이미 stage_metadata에 박혀 있다
 * (디렉터 축, PO 판定 2026-09-18: "새 바인딩 축 아님"). recipe_role_bindings와 무관한 읽기
 * 전용 정보라 role_mapping 계열 함수와 분리한다. */
export interface RecipeGateStage {
  stage: string;
  role: string | null;
  gate: { type?: string; approver?: string };
}

export function stagesWithGate(stageMetadata: RecipeStageMetadata): RecipeGateStage[] {
  const out: RecipeGateStage[] = [];
  for (const [stage, meta] of Object.entries(stageMetadata)) {
    if (!meta?.gate) continue;
    out.push({ stage, role: meta.role ?? null, gate: meta.gate });
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
