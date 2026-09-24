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
// story #4173(E-RECIPE-2)부터 이 판별은 역할 이름이 아니라 정의의 신호(capability.target·gate·
// role_actor_kinds)로 stage마다 한다 — recipeRoleSlots 참조(예전 expandRoleSlotBindings의
// bindableRoles 화이트리스트는 역할 전체를 한 방식으로 펼쳐서, 한 역할에 방식이 다른 stage가
// 섞이면 틀린 값을 꽂았다 — 제거).

// story #3316 SSOT(EventDefinitionResponse['stage_metadata'], loop-create-dialog.tsx)와
// 구조적으로 호환되게 optional 필드를 그대로 맞춘다 — import는 안 한다(lib/는 components/에
// 의존하지 않는 방향 관례, 이 파일은 컴포넌트 레이어 밖에서도 재사용 가능해야 한다). TS
// structural typing이라 호출부는 캐스팅 없이 EventDefinitionResponse['stage_metadata']를
// 그대로 넘길 수 있다.
export interface RecipeStageMeta {
  role?: string;
  action?: string;
  gate?: { type?: string; approver?: string };
  capability?: { kind?: string; connector_key?: string; target?: string; channels?: string[] };
  /** story #4174 후속 — 이 stage의 승인이 stage 밖(결재함의 초안 게이트)에서 일어남을 정의가 선언(닫힌 어휘, BE
   * `validate_stage_metadata`가 강제). 승인자는 싣지 않는다 — 그 게이트 쪽 규칙이 정한다. */
  approval?: { surface?: string };
}

export type RecipeStageMetadata = Record<string, RecipeStageMeta>;

// story #4092(E-RECIPE-1 팔로우업, PO 확定 2026-09-21 §b) — 정의가 자기 role 어휘로 선언하는
// 옵션 사전({role명: "human"|"agent"}). role은 자유 문자열(위 docstring 그대로)이라 role
// 이름 자체는 고정 어휘가 아니다 — 닫힌 건 kind 값 둘뿐(BE event_definition_registry.py
// ROLE_ACTOR_KIND_VALUES와 동일 어휘, 재구현 아님·값만 미러).
export type RoleActorKinds = Record<string, 'human' | 'agent'>;

/**
 * role 문자열 → 사람/에이전트 분류. 정의가 role_actor_kinds를 선언 안 했거나("모름") 그
 * role이 선언 안에 없으면 null — 지어내지 않는다. story #4173부터 역할 순서(사람 먼저)·
 * 적용 자리 판별(recipeRoleSlots)·카드 «(사람)» 표시가 이 값을 읽는다.
 */
export function roleActorKind(role: string | undefined, roleActorKinds: RoleActorKinds | null | undefined): 'human' | 'agent' | null {
  if (!role || !roleActorKinds) return null;
  return roleActorKinds[role] ?? null;
}

/** stage_metadata를 role 라벨별로 묶는다(정보 그룹핑 — "이 role이 role_mapping 바인딩
 * 대상"이라는 뜻이 아니다, 그건 recipeRoleSlots가 stage마다 판단한다).
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

// ── story #4173(E-RECIPE-2) — 레시피 종류에 묶인 상수 없이 정의 자체로 역할·연결을 구동 ──
// 예전엔 적용 다이얼로그가 영상 레시피 4슬롯(Director/Creator/Compute/Publisher)을 고정으로
// 그렸고, «크리에이터» 축을 가리키는 레시피 전용 role 키 상수를 페이지가 넘겼다. 아래
// 함수들은 stage_metadata·role_actor_kinds·payload_schema 흐름 순서만 읽는다.

/** 조직 연결이 필요한 capability.target과 필수 여부 — 카드(«연결» 행)와 적용 다이얼로그
 * (연산 슬롯은 비워도 제출 가능)가 같은 표를 본다. 순서 = 표시 순서(필수 먼저).
 * generation_connector가 선택인 근거: 비워 두면 담당 에이전트가 자기 도구로 생성한다(#4110). */
export const RECIPE_CONNECTION_TARGETS = [
  { target: 'channel_connection', optional: false },
  { target: 'generation_connector', optional: true },
] as const;

/** 정의가 요구하는 조직 연결 종류(표 순서). agent·미지정 target은 연결이 아니라 뺀다. */
export function recipeConnectionTargets(stageMetadata: RecipeStageMetadata): (typeof RECIPE_CONNECTION_TARGETS)[number][] {
  const declared = new Set(Object.values(stageMetadata).map((m) => m?.capability?.target).filter(Boolean));
  return RECIPE_CONNECTION_TARGETS.filter((c) => declared.has(c.target));
}

/** stage를 흐름 순서로 — payload_schema stage enum 순서가 정본이고, enum에 없는 stage는
 * stage_metadata 순서대로 뒤에 붙인다(stage_metadata의 JSON 키 순서는 흐름 순서가 아니다 —
 * 실 seed는 DB JSONB 저장 순서로 나온다). */
export function stagesInFlowOrder(stageMetadata: RecipeStageMetadata, flowStages: readonly string[]): string[] {
  const inFlow = flowStages.filter((s) => Object.hasOwn(stageMetadata, s));
  const rest = Object.keys(stageMetadata).filter((s) => !flowStages.includes(s));
  return [...inFlow, ...rest];
}

/** 역할 순서 — 사람 역할(role_actor_kinds 선언이 human) 먼저, 그다음 흐름에서 처음 나오는
 * 순서. 갤러리 카드 «역할» 행과 적용 다이얼로그 슬롯이 이 함수 하나를 쓴다(두 화면 순서가
 * 갈리지 않게). 영상 레시피 = Director · Creator · Compute · Publisher. */
export function orderedRecipeRoles(
  stageMetadata: RecipeStageMetadata,
  flowStages: readonly string[],
  roleActorKinds: RoleActorKinds | null | undefined,
): string[] {
  const seen: string[] = [];
  for (const stage of stagesInFlowOrder(stageMetadata, flowStages)) {
    const role = stageMetadata[stage]?.role;
    if (role && !seen.includes(role)) seen.push(role);
  }
  const human = seen.filter((r) => roleActorKind(r, roleActorKinds) === 'human');
  return [...human, ...seen.filter((r) => !human.includes(r))];
}

/** 적용 다이얼로그 한 자리. 한 역할의 stage를 «어떤 방식으로 채우는가»별로 나눠, 방식마다
 * 자리 하나를 낸다(한 역할이 방식이 다른 stage를 가지면 자리가 여럿 — 예: Writer = 멤버
 * 자리(draft) + 채널 자리(published), 사람 역할 = 멤버 자리(작업) + 승인 자리(게이트)).
 * stage 하나의 방식:
 * - channel: capability.target=channel_connection → 조직 채널 연결(필수).
 * - compute: capability.target=generation_connector → 연산 커넥터(선택).
 * - approver: 사람 역할의 게이트 stage → 게이트 승인 주체를 읽기 전용으로(role_mapping 축 아님).
 * - member: 그 밖 → 팀 멤버(사람 역할이면 사람, 아니면 에이전트)에 바인딩(필수).
 * 사람 역할 = role_actor_kinds가 human으로 선언, 또는 선언이 없는 역할이면서 그 역할의 모든
 * stage가 게이트. 선언 없는 역할은 다른 역할의 선언 여부와 상관없이 이 한 규칙으로 판정한다.
 * `key`(역할+방식)가 다이얼로그 선택값의 키다. 불변식: role이 있는 모든 stage가 정확히 한
 * 자리에 덮인다(uncoveredRecipeStages). */
export type RecipeSlotKind = 'approver' | 'approval_elsewhere' | 'member' | 'compute' | 'channel';

export interface RecipeRoleSlot {
  key: string;
  role: string;
  kind: RecipeSlotKind;
  stages: string[];
  memberType: 'agent' | 'human';
  gateApprovers: string[];
}

function isHumanRole(roleStages: string[], stageMetadata: RecipeStageMetadata, declared: 'human' | 'agent' | null): boolean {
  if (declared !== null) return declared === 'human';
  return roleStages.length > 0 && roleStages.every((s) => stageMetadata[s]?.gate || stageMetadata[s]?.approval);
}

function stageSlotKind(meta: RecipeStageMeta, isHuman: boolean): RecipeSlotKind {
  const target = meta.capability?.target;
  if (target === 'channel_connection') return 'channel';
  if (target === 'generation_connector') return 'compute';
  if (isHuman && meta.gate) return 'approver';
  // story #4174 후속 — 승인이 이 stage 밖(초안 게이트)이라고 정의가 선언한 사람 stage는 고를 사람이 없는 읽기 전용
  // 자리. 선언 없는 사람 비게이트 stage는 사람이 실제로 일하는 단계라 아래 멤버 자리(까디르 QA 재현 C).
  if (isHuman && meta.approval?.surface) return 'approval_elsewhere';
  return 'member';
}

export function recipeRoleSlots(
  stageMetadata: RecipeStageMetadata,
  flowStages: readonly string[],
  roleActorKinds: RoleActorKinds | null | undefined,
): RecipeRoleSlot[] {
  const flow = stagesInFlowOrder(stageMetadata, flowStages);
  return orderedRecipeRoles(stageMetadata, flowStages, roleActorKinds).flatMap((role) => {
    const roleStages = flow.filter((s) => stageMetadata[s]?.role === role);
    const isHuman = isHumanRole(roleStages, stageMetadata, roleActorKind(role, roleActorKinds));
    // 자리 순서 = 그 자리의 첫 stage 흐름 순서(roleStages가 이미 흐름 순서라 처음 나온 순서).
    const slots: RecipeRoleSlot[] = [];
    for (const stage of roleStages) {
      const meta = stageMetadata[stage]!;
      const kind = stageSlotKind(meta, isHuman);
      let slot = slots.find((x) => x.kind === kind);
      if (!slot) {
        slot = { key: `${role}:${kind}`, role, kind, stages: [], memberType: isHuman ? 'human' : 'agent', gateApprovers: [] };
        slots.push(slot);
      }
      slot.stages.push(stage);
      if (kind === 'approver') slot.gateApprovers.push(meta.gate!.approver ?? '');
    }
    return slots;
  });
}

// capability.target이 있는 stage는 그 방식의 자리에만 들어갈 수 있다(다른 자리에 들어가면 그
// 연결 값이 제출에서 빠진다 — 승인 자리는 읽기 전용이라 값이 없다).
const TARGET_SLOT_KIND: Record<string, RecipeSlotKind> = {
  channel_connection: 'channel',
  generation_connector: 'compute',
};

/** 불변식 검사 — role이 있는 stage 중 ① 자리에 안 덮였거나 ② 둘 이상에 덮였거나 ③ 맞지 않는
 * 방식의 자리에 덮인(capability.target stage가 그 방식 밖의 자리에 있는) stage(흐름 순서).
 * 비어 있지 않으면 적용 다이얼로그가 제출을 막고 그 stage를 보여준다(fail-closed) — 앞으로
 * 정의 모양이 늘어도 «표시 없이 바인딩에서 빠진 채 제출 성공»이 다시 생기지 않게 하는 안전망. */
export function uncoveredRecipeStages(
  stageMetadata: RecipeStageMetadata,
  flowStages: readonly string[],
  slots: readonly RecipeRoleSlot[],
): string[] {
  const count = new Map<string, number>();
  const wrongKind = new Set<string>();
  for (const slot of slots) {
    for (const stage of slot.stages) {
      count.set(stage, (count.get(stage) ?? 0) + 1);
      const required = TARGET_SLOT_KIND[stageMetadata[stage]?.capability?.target ?? ''];
      if (required && slot.kind !== required) wrongKind.add(stage);
    }
  }
  return stagesInFlowOrder(stageMetadata, flowStages)
    .filter((s) => stageMetadata[s]?.role && (count.get(s) !== 1 || wrongKind.has(s)));
}

/** story #4239 — 채널 자리가 받을 수 있는 채널 종류. 자리의 stage들이 선언한 `capability.channels`의 교집합(선언 안 한
 * stage는 제한 없음). 아무 stage도 선언 안 했으면 null(= 제한 없음 · 예전대로). 정의가 원천 — 레시피 이름 상수 없음. */
export function allowedChannelsForSlot(slot: RecipeRoleSlot, stageMetadata: RecipeStageMetadata): string[] | null {
  let allowed: string[] | null = null;
  for (const stage of slot.stages) {
    const declared = stageMetadata[stage]?.capability?.channels;
    if (!declared) continue;
    allowed = allowed === null ? [...declared] : allowed.filter((c) => declared.includes(c));
  }
  return allowed;
}
