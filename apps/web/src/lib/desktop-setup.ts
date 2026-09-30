// story #4427(E-DESKTOP P2 — 첫 실행 설정) — 웹 설정 페이지(/desktop/setup)의 순수 규칙.
// 데스크톱 앱이 설정 코드와 «이 컴퓨터에서 찾은 에이전트» 목록을 주소로 넘겨 이 페이지를 연다(데스크톱 전용 화면 X —
// 이 페이지는 웹 페이지다). 사람은 기본값이 채워진 채 열린 페이지에서 «시작» 한 번만 누른다(유나 시안 v3 · PO 07:14Z 기본값 규칙):
// - 레시피 = 목록 첫째(추천 딱지 없음 — 정의에 추천 값이 없다).
// - 역할 주체: role_actor_kinds[role] = human → 새 에이전트 없이 «시작»을 누른 사람 · agent · either · 선언 없음 → 이 컴퓨터의
//   에이전트(either는 «나»로 바꿀 수 있다). 기본 에이전트 = 찾은 것 중 고정 순서 첫째(Claude Code → Codex).
// - 채널 연결 · 연산 커넥터 stage는 «나중에 연결»(여기서 고르지 않는다 · 4424 할 일 6).
// - 작업 폴더는 제안일 뿐 — 최종 판단은 데스크톱 로컬 층(홈 안 · `..` 없음 …)이 한다(PO 08:15Z).
/** A role's kind from the server (4831): human → the person confirming · agent → one of this computer's agents · either → an agent,
 * or «나». The same union the recipe preset uses. */
export type RoleActorKind = 'human' | 'agent' | 'either';

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

/** One row the server worked out for the setup (4831 `setup_role_rows` — the same function the confirmation checks with). */
export interface SetupRecipeRole { role: string; kind: RoleActorKind; stages: string[] }

/** A recipe the desktop setup can start (`GET /api/v2/desktop/recipes` · 4831): only startable ones come, each with its rows. */
export interface SetupRecipe {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  roles: SetupRecipeRole[];
}

/**
 * The page's rows: the server's rows as they come, in their order (PO 16:03Z — one place counts the setup roles; the web
 * used to work them out itself and dropped approval-only roles that the confirmation needs → `roles_invalid`). The web only
 * fills in who takes each row from the agents found on this computer.
 */
export function setupRoleRows(recipe: SetupRecipe, runtimes: readonly DesktopRuntime[]): SetupRoleRow[] {
  const agents: RowOwner[] = runtimes.map((runtime) => ({ kind: 'agent', runtime }));
  const me: RowOwner = { kind: 'me' };
  // people's roles first, then the server's order — the order the recipe gallery and the apply dialog use
  // (orderedRecipeRoles · Yuna 12:49Z: one order per recipe across the product)
  const ordered = [...recipe.roles.filter((r) => r.kind === 'human'), ...recipe.roles.filter((r) => r.kind !== 'human')];
  return ordered.map(({ role, kind, stages }) => {
    const choices = kind === 'human' ? [me] : kind === 'either' ? [...agents, me] : agents;
    // 찾은 에이전트가 없으면(실패 ①) 에이전트 줄의 기본값이 없다 — 페이지가 ① 화면을 보이고 «시작»을 막는다.
    const owner = kind === 'human' ? me : (agents[0] ?? me);
    return { role, actor: kind, stages: [...stages], choices, owner };
  });
}

/**
 * A recipe the page lists: the server sends only startable ones (on · a flow · an agent row · a name — 4831); the page still
 * never shows a key as a name nor a people-only card (a display guard, not the rule — PO 00:19Z ①).
 */
export function listableRecipe(recipe: SetupRecipe, displayName: string): boolean {
  const name = displayName.trim();
  return !!name && name !== recipe.key && recipe.roles.some((r) => r.kind !== 'human');
}

/** 찾은 에이전트 없이 에이전트만 맡을 수 있는 줄이 있으면 시작할 수 없다(실패 ①). */
export function needsAnAgent(rows: readonly SetupRoleRow[], runtimes: readonly DesktopRuntime[]): boolean {
  return runtimes.length === 0 && rows.some((r) => r.actor === 'agent');
}

/** «에이전트 N개» — 에이전트가 맡는 줄 수(= 새로 만들 에이전트 수). */
export function agentRowCount(rows: readonly SetupRoleRow[]): number {
  return rows.filter((r) => r.owner.kind === 'agent').length;
}

/** 주소의 `#`가 설정 값(code=…)을 싣고 있으면 지운다 — 다른 `#`(문서 안 앵커 등)는 건드리지 않는다. */
export function hasSetupFragment(hash: string): boolean {
  return /(^#|&)code=/.test(hash);
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
  /** 설정 코드는 본문으로만(경로 X — PO 09:45Z · 디디 4825). */
  code: string;
  project_id: string;
  recipe_id: string;
  /** 에이전트 단위 = 역할(PO 08:31Z · 4825 CHANGES): 한 역할이 여러 stage를 맡아도 에이전트 하나. */
  roles: { role: string; runtime: DesktopRuntime }[];
  workdir_hint: string;
}

/** 확인 요청(4424 confirm) — 에이전트가 맡는 역할마다 {role, runtime}(역할 하나 = 에이전트 하나). 사람이 맡는 줄은 싣지
 * 않는다(BE가 확인을 누른 사람에게 묶는다 — PO 07:14Z). */
export function confirmBody(code: string, rows: readonly SetupRoleRow[], projectId: string, recipeId: string, workdirHint: string): ConfirmBody {
  return {
    code,
    project_id: projectId,
    recipe_id: recipeId,
    roles: rows.flatMap((r) => (r.owner.kind === 'agent' ? [{ role: r.role, runtime: r.owner.runtime }] : [])),
    workdir_hint: workdirHint.trim(),
  };
}

// ── story #4427 — 설정 값은 `#` 뒤로만 ──
// 설정 코드는 어떤 URL에도 싣지 않는다(까디르 4825 · PO 09:45Z): 앱이 `#` 뒤(fragment)로 넘기고 — 서버 요청 · 로그 · Referer에
// 안 남는다 — 페이지는 읽자마자 주소에서 지우고 메모리에만 둔다. 로그인을 거치면 `#`이 따라오지 않는데, 그때는 코드를 쥔
// 데스크톱 앱이 설정 페이지를 다시 연다(PO 09:58Z) — 웹은 코드를 맡아 두지 않는다.

/** `#code=…&setup=…&runtimes=…` → SetupQuery (모양이 틀리면 null). */
export function parseSetupFragment(hash: string): SetupQuery | null {
  return parseSetupQuery(new URLSearchParams(hash.replace(/^#/, '')));
}

// ── story #4427 · AC2 «문서 0» — desktop_doc_opened(PO 08:44Z) ──
// 설정이 진행 중인 동안(같은 탭) 웹에서 문서 · 가이드 링크를 열면 한 번씩 보낸다. 표시는 설정 페이지에 들어올 때 남기고, «시작» 뒤엔
// 진행 조회(2초)마다 새로 적으며, 흐름이 끝나면(결과 · ④ · ⑥) 지운다 — 30분은 «마지막으로 적은 때부터»(진행이 30분을 넘겨도
// 덜 세지 않는다 · PO 13:00Z «더 셀 수는 있어도 덜 세지 않음»).
const ACTIVE_SETUP = 'sprintable_desktop_setup_active';
export const ACTIVE_SETUP_TTL_MS = 30 * 60_000;

export function rememberActiveSetup(setupId: string, now = Date.now(), storage: Pick<Storage, 'setItem'> | undefined = globalThis.sessionStorage): void {
  try { storage?.setItem(ACTIVE_SETUP, JSON.stringify({ setupId, at: now })); } catch { /* 측정만 빠진다 */ }
}

export function forgetActiveSetup(storage: Pick<Storage, 'removeItem'> | undefined = globalThis.sessionStorage): void {
  try { storage?.removeItem(ACTIVE_SETUP); } catch { /* 측정만 빠진다 */ }
}

export function activeSetupId(now = Date.now(), storage: Pick<Storage, 'getItem'> | undefined = globalThis.sessionStorage): string | null {
  try {
    const v = JSON.parse(storage?.getItem(ACTIVE_SETUP) ?? 'null') as { setupId?: unknown; at?: unknown } | null;
    if (!v || typeof v.setupId !== 'string' || typeof v.at !== 'number' || now - v.at > ACTIVE_SETUP_TTL_MS) return null;
    return v.setupId;
  } catch { return null; }
}

/** 문서 · 가이드 링크인가 — sprintable.ai의 글(blog · docs · guide) · 앱의 연결 가이드(/llms · *guide*) · 도움말(/help). 앱 안
 * 일감 문서(/docs/{id} — 조직 문서함)는 «가이드»가 아니라 셈하지 않는다. */
export function isGuideLink(href: string, appOrigin: string): boolean {
  let u: URL;
  try { u = new URL(href, appOrigin); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname;
  if (host === 'sprintable.ai' || host === 'www.sprintable.ai' || host === 'docs.sprintable.ai') {
    return host === 'docs.sprintable.ai' || /\/(blog|docs|guide|guides|help)(\/|$)/.test(u.pathname);
  }
  if (u.origin !== new URL(appOrigin).origin) return false;
  return /^\/(llms|help)(\/|$|\.)/.test(u.pathname) || /guide/i.test(u.pathname.split('/').pop() ?? '');
}

/**
 * «시작» 뒤 진행 표시(유나 시안 v12 · PO 12:25Z) — `GET /api/v2/desktop/setups/{id}`(4826) 한 번의 응답을 세 단계로 읽는다.
 * - ① 준비: 앱이 설정을 받았고(handed_over) 에이전트마다 도구 연결(tools_connected)이 왔으면 끝.
 * - ② 맡김: 건넴(first_task_handed_at) 또는 결과(first_result_at)가 있으면 끝 — 결과가 있으면 건넴은 반드시 있었다(영구 규칙).
 * - ③ 결과: first_result_at.
 * - 신뢰 창 안내: 앱이 받은 뒤 · 도구 연결이 다 오기 전(창이 떴는지는 잴 수 없어 단정하지 않는 문구 · PO 12:25Z).
 * - ⑦ 연결 안 붙음: 받은 뒤 도구 연결이 없는 에이전트가 있고, (사람 입력 + 30초) 또는 (받은 것을 본 때 + 180초)가 지남 —
 *   처음 켤 때 폴더 신뢰 창에 답하기 전엔 연결이 붙지 않으므로 고정 60초는 거짓 경보(PO 12:25Z).
 */
export interface SetupStatus {
  state: 'waiting_for_app' | 'handed_over' | 'not_handed_over' | 'disconnected';
  recipe_name: string | null;
  work_item_id: string | null;
  members: { stage: string; role: string | null; member_id: string; kind: 'agent' | 'human'; runtime: DesktopRuntime | null }[];
  signals: {
    tools_connected: { member_id: string; at: string }[];
    first_task_handed_at: string | null;
    first_result_at: string | null;
    workdir_fallback_at: string | null;
    blocked: { at: string; reason: string | null } | null;
    /** 디디군 이벤트 신뢰 PR에서 더해질 값 — 없으면 180초 쪽만 쓴다. */
    first_screen_human_input_at?: string | null;
  };
}

export type StepState = 'running' | 'done';
export const NOT_CONNECTED_AFTER_INPUT_MS = 30_000;
export const NOT_CONNECTED_AFTER_HANDOVER_MS = 180_000;

export interface SetupProgress {
  ready: StepState;
  handed: StepState;
  result: StepState;
  /** ① 끝 줄 «{역할} · {런타임}, …» — 에이전트 역할마다 한 번(한 역할이 여러 stage에 걸쳐도). */
  pairs: { role: string; runtime: DesktopRuntime }[];
  /** ② 설명의 «{역할} 에이전트» — 흐름 순서의 첫 에이전트 역할. */
  firstAgentRole: string | null;
  workdirFallback: boolean;
  trustHint: boolean;
  notConnected: boolean;
  /** 받은 뒤 회사 설정으로 막힘(⑥ · 셸의 after_start 신호) → ⑥ 화면. */
  blocked: boolean;
  /** 코드가 먼저 끝나 앱이 받지 못함 → ④ 화면(앱에서 다시 시작). */
  expired: boolean;
}

/** `handedOverSeenAt` = 이 페이지가 handed_over를 처음 본 때(상태 조회에 받은 시각이 없어 페이지 시계로 잰다). */
export function setupProgress(s: SetupStatus, now: number, handedOverSeenAt: number | null): SetupProgress {
  const agents = s.members.filter((m) => m.kind === 'agent');
  const agentIds = [...new Set(agents.map((m) => m.member_id))];
  const connected = new Set(s.signals.tools_connected.map((c) => c.member_id));
  const handedOver = s.state === 'handed_over';
  const allConnected = agentIds.length > 0 && agentIds.every((id) => connected.has(id));
  const ready: StepState = handedOver && allConnected ? 'done' : 'running';
  const result: StepState = s.signals.first_result_at ? 'done' : 'running';
  const handed: StepState = s.signals.first_task_handed_at || s.signals.first_result_at ? 'done' : 'running';
  const pairs: SetupProgress['pairs'] = [];
  for (const m of agents) {
    if (m.role && m.runtime && !pairs.some((p) => p.role === m.role)) pairs.push({ role: m.role, runtime: m.runtime });
  }
  const input = s.signals.first_screen_human_input_at ? Date.parse(s.signals.first_screen_human_input_at) : NaN;
  const waitingForTools = handedOver && !allConnected && result === 'running';
  const notConnected = waitingForTools && (
    (Number.isFinite(input) && now - input >= NOT_CONNECTED_AFTER_INPUT_MS)
    || (handedOverSeenAt !== null && now - handedOverSeenAt >= NOT_CONNECTED_AFTER_HANDOVER_MS));
  return {
    ready, handed, result, pairs,
    firstAgentRole: agents.find((m) => m.role)?.role ?? null,
    workdirFallback: !!s.signals.workdir_fallback_at,
    trustHint: waitingForTools && !notConnected,
    notConnected,
    blocked: !!s.signals.blocked,
    expired: s.state === 'not_handed_over',
  };
}

/** 폴링 간격(PO 12:25Z). 결과가 나오거나 화면이 실패로 바뀌면 멈춘다. */
export const SETUP_STATUS_POLL_MS = 2_000;
