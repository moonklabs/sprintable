// story #4427(E-DESKTOP P2 — 첫 실행 설정) — 웹 설정 페이지(/desktop/setup)의 순수 규칙.
// 데스크톱 앱이 설정 코드와 «이 컴퓨터에서 찾은 에이전트» 목록을 주소로 넘겨 이 페이지를 연다(데스크톱 전용 화면 X —
// 이 페이지는 웹 페이지다). 사람은 기본값이 채워진 채 열린 페이지에서 «시작» 한 번만 누른다(유나 시안 v3 · PO 07:14Z 기본값 규칙):
// - 레시피 = 목록 첫째(추천 딱지 없음 — 정의에 추천 값이 없다).
// - 역할 주체: role_actor_kinds[role] = human → 새 에이전트 없이 «시작»을 누른 사람 · agent · either · 선언 없음 → 이 컴퓨터의
//   에이전트(either는 «나»로 바꿀 수 있다). 기본 에이전트 = 찾은 것 중 고정 순서 첫째(Claude Code → Codex).
// - 채널 연결 · 연산 커넥터 stage는 «나중에 연결»(여기서 고르지 않는다 · 4424 할 일 6).
// - 작업 폴더는 제안일 뿐 — 최종 판단은 데스크톱 로컬 층(홈 안 · `..` 없음 …)이 한다(PO 08:15Z).
import {
  orderedRecipeRoles, roleActorKind, stageApprovalSurface, stageMemberKind, stagesInFlowOrder,
  type RecipeStageMetadata, type RoleActorKind, type RoleActorKinds,
} from './recipe-role-slots';

/** 데스크톱 앱이 찾는 런타임 — 고정 순서(기본값은 이 순서의 첫째). 셸 runtimes.ts와 같은 id. */
export const DESKTOP_RUNTIMES = ['claude', 'codex'] as const;
export type DesktopRuntime = (typeof DESKTOP_RUNTIMES)[number];

/** 설정 코드(BE 4424: 43자 base64url). 모양이 틀리면 «코드 없음»과 같게 본다. */
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** `setup` = 설정 id(setup-codes 201) — 이 흐름의 이벤트 session_id. 모양이 틀리면 없음으로. */
export interface SetupQuery { code: string; runtimes: DesktopRuntime[]; setupId: string | null; /** 찾았지만 이 컴퓨터에서 도구를 못 붙이는 것(⑥ · 회사 관리 MCP) — runtimes의 부분집합. */ blocked: DesktopRuntime[] }

/** `?code=&runtimes=claude,codex` → 코드 · 런타임(모르는 값 버림 · 중복 제거 · 고정 순서). 코드가 없거나 틀리면 null
 * (= «데스크톱 앱에서 열어 주세요»). 런타임이 비어 있어도 코드가 맞으면 페이지는 열린다(실패 ① 화면). */
export function parseSetupQuery(params: { get(name: string): string | null }): SetupQuery | null {
  const code = params.get('code') ?? '';
  if (!CODE_RE.test(code)) return null;
  const asked = new Set((params.get('runtimes') ?? '').split(',').map((s) => s.trim()));
  const setup = params.get('setup') ?? '';
  const runtimes = DESKTOP_RUNTIMES.filter((r) => asked.has(r));
  const blockedAsked = new Set((params.get('blocked') ?? '').split(',').map((s) => s.trim()));
  return { code, runtimes, setupId: /^[A-Za-z0-9-]{1,64}$/.test(setup) ? setup : null, blocked: runtimes.filter((r) => blockedAsked.has(r)) };
}

export type RowOwner = { kind: 'me' } | { kind: 'agent'; runtime: DesktopRuntime };

export interface SetupRoleRow {
  role: string;
  /** 선언 그대로(없으면 agent — 적용 창 stageMemberKind와 같은 규칙). */
  actor: RoleActorKind;
  /** 이 줄이 맡는 stage(멤버 자리만 · 흐름 순서). 채널 · 연산 · 승인이 stage 밖인 자리는 빠진다. */
  stages: string[];
  /** 고를 수 있는 쪽: human → 나만 · agent → 에이전트만 · either → 에이전트 + 나. */
  choices: RowOwner[];
  owner: RowOwner;
}

export interface SetupRecipe {
  id: string;
  key: string;
  org_id?: string | null;
  name: string;
  description?: string | null;
  stage_metadata?: RecipeStageMetadata | null;
  role_actor_kinds?: RoleActorKinds | null;
  payload_schema?: { properties?: { stage?: { enum?: string[] } } } | null;
}

export function flowStages(recipe: SetupRecipe): string[] {
  return recipe.payload_schema?.properties?.stage?.enum ?? [];
}

/** 역할마다 한 줄, 기본값이 채워진 채. 멤버 자리 stage가 없는 역할(채널 · 연산만)은 줄이 없다(«나중에 연결»). */
export function setupRoleRows(recipe: SetupRecipe, runtimes: readonly DesktopRuntime[]): SetupRoleRow[] {
  const meta = recipe.stage_metadata ?? {};
  const kinds = recipe.role_actor_kinds ?? null;
  const flow = stagesInFlowOrder(meta, flowStages(recipe));
  const agents: RowOwner[] = runtimes.map((runtime) => ({ kind: 'agent', runtime }));
  const me: RowOwner = { kind: 'me' };
  return orderedRecipeRoles(meta, flowStages(recipe), kinds).flatMap((role) => {
    const stages = flow.filter((s) => meta[s]?.role === role
      && stageMemberKind(s, meta, kinds) !== null && stageApprovalSurface(s, meta, kinds) === null);
    if (stages.length === 0) return [];
    const actor: RoleActorKind = roleActorKind(role, kinds) ?? 'agent';
    const choices = actor === 'human' ? [me] : actor === 'either' ? [...agents, me] : agents;
    // 찾은 에이전트가 없으면(실패 ①) 에이전트 줄의 기본값이 없다 — 페이지가 ① 화면을 보이고 «시작»을 막는다.
    const owner = actor === 'human' ? me : (agents[0] ?? me);
    return [{ role, actor, stages, choices, owner }];
  });
}

/** 찾은 에이전트 없이 에이전트만 맡을 수 있는 줄이 있으면 시작할 수 없다(실패 ①). */
export function needsAnAgent(rows: readonly SetupRoleRow[], runtimes: readonly DesktopRuntime[]): boolean {
  return runtimes.length === 0 && rows.some((r) => r.actor === 'agent');
}

/** «에이전트 N개» — 에이전트가 맡는 줄 수(= 새로 만들 에이전트 수). */
export function agentRowCount(rows: readonly SetupRoleRow[]): number {
  return rows.filter((r) => r.owner.kind === 'agent').length;
}

/** 작업 폴더 입력칸의 미리 막기(유나 08:16Z): 빈 칸 · «~» · «~/» 그 자체는 «시작» 비활성. 나머지 판단은 로컬 층. */
export function workdirInputOk(value: string): boolean {
  const v = value.trim();
  return v !== '' && v !== '~' && v !== '~/' && v !== '/';
}

export function defaultWorkdirHint(recipeName: string): string {
  const n = recipeName.replace(/[\u0000-\u001f\u007f/\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return n && !/^\.+$/.test(n) ? `~/Sprintable/${n}` : '~/Sprintable';
}

export interface ConfirmBody {
  project_id: string;
  recipe_id: string;
  /** 에이전트 단위 = 역할(PO 08:31Z · 4825 CHANGES): 한 역할이 여러 stage를 맡아도 에이전트 하나. */
  roles: { role: string; runtime: DesktopRuntime }[];
  workdir_hint: string;
}

/** 확인 요청(4424 confirm) — 에이전트가 맡는 역할마다 {role, runtime}(역할 하나 = 에이전트 하나). 사람이 맡는 줄은 싣지
 * 않는다(BE가 확인을 누른 사람에게 묶는다 — PO 07:14Z). */
export function confirmBody(rows: readonly SetupRoleRow[], projectId: string, recipeId: string, workdirHint: string): ConfirmBody {
  return {
    project_id: projectId,
    recipe_id: recipeId,
    roles: rows.flatMap((r) => (r.owner.kind === 'agent' ? [{ role: r.role, runtime: r.owner.runtime }] : [])),
    workdir_hint: workdirHint.trim(),
  };
}
