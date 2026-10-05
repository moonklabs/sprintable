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
export interface SetupQuery { code: string; runtimes: DesktopRuntime[]; setupId: string | null; /** 찾았지만 이 컴퓨터에서 도구를 못 붙이는 것(⑥ · 회사 관리 MCP) — runtimes의 부분집합. */ blocked: DesktopRuntime[]; /** story 4494: 이 컴퓨터에 깔렸지만 바닥보다 낮은 판뿐인 런타임(쓸 수 없음) — runtimes에 없는 것만. */ old?: OldRuntime[] }

/** story 4494 (PO 10:00Z (a)): the app's `old=codex:0.153.4:0.156.1` — a runtime installed only below its floor (its version · the
 * lowest that works). The page says «버전이 낮아» for it instead of «찾지 못했어요». */
export interface OldRuntime { runtime: DesktopRuntime; version: string; min: string }
const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** only when there is one — the parsed shape stays as before for every address without `old=` */
const withOld = (old: OldRuntime[]): { old?: OldRuntime[] } => (old.length ? { old } : {});

/** `old=` → each runtime at most once, in the fixed order. A broken entry (not three fields · an unknown runtime · a version that is
 * not N.N.N · one that was also found) is dropped — the page then says what it said before. */
export function parseOldRuntimes(value: string | null, found: readonly DesktopRuntime[]): OldRuntime[] {
  const byRuntime = new Map<DesktopRuntime, OldRuntime>();
  for (const part of (value ?? '').split(',')) {
    const bits = part.trim().split(':');
    if (bits.length !== 3) continue;
    const [r, version, min] = bits as [string, string, string];
    const runtime = DESKTOP_RUNTIMES.find((x) => x === r);
    if (!runtime || found.includes(runtime) || byRuntime.has(runtime) || !VERSION_RE.test(version) || !VERSION_RE.test(min)) continue;
    byRuntime.set(runtime, { runtime, version, min });
  }
  return DESKTOP_RUNTIMES.flatMap((r) => (byRuntime.has(r) ? [byRuntime.get(r)!] : []));
}

/** `?code=&runtimes=claude,codex` → 코드 · 런타임(모르는 값 버림 · 중복 제거 · 고정 순서). 코드가 없거나 틀리면 null
 * (= «데스크톱 앱에서 열어 주세요»). 런타임이 비어 있어도 코드가 맞으면 페이지는 열린다(실패 ① 화면). */
export function parseSetupQuery(params: { get(name: string): string | null }): SetupQuery | null {
  const code = params.get('code') ?? '';
  if (!CODE_RE.test(code)) return null;
  const asked = new Set((params.get('runtimes') ?? '').split(',').map((s) => s.trim()));
  const setup = params.get('setup') ?? '';
  const runtimes = DESKTOP_RUNTIMES.filter((r) => asked.has(r));
  const blockedAsked = new Set((params.get('blocked') ?? '').split(',').map((s) => s.trim()));
  return { code, runtimes, setupId: /^[A-Za-z0-9-]{1,64}$/.test(setup) ? setup : null, blocked: runtimes.filter((r) => blockedAsked.has(r)), ...withOld(parseOldRuntimes(params.get('old'), runtimes)) };
}

/** `existing` (story #4565): an agent the organization already has, moved to this computer for the row (no new member). */
export type RowOwner = { kind: 'me' } | { kind: 'agent'; runtime: DesktopRuntime } | { kind: 'existing'; agentId: string; name: string; runtime: DesktopRuntime };

/** story #4565 — `GET /api/v2/desktop/setup/agents` row: an agent the setup may attach (this org · this project · a desktop
 * runtime), its live key count (any → moving it cuts its current connection) and when one was last used. No key value. */
export interface AttachableAgent { id: string; name: string; runtime: DesktopRuntime; live_keys: number; last_used_at: string | null }

/** The «이미 있는 에이전트» choices of a row (agent · either rows only): every attachable agent whose runtime is on this computer.
 * The page draws the others (runtime not here · picked for another row) as disabled options with why. */
export function existingChoices(attachable: readonly AttachableAgent[], runtimes: readonly DesktopRuntime[]): RowOwner[] {
  return attachable.filter((a) => runtimes.includes(a.runtime)).map((a) => ({ kind: 'existing', agentId: a.id, name: a.name, runtime: a.runtime }));
}

/** The rows with the attachable agents added to each agent · either row's choices (after the new runtimes, before «나»). An
 * owner that is no longer among them (the list changed) goes back to the row's first choice. */
export function withAttachable(rows: readonly SetupRoleRow[], attachable: readonly AttachableAgent[], runtimes: readonly DesktopRuntime[]): SetupRoleRow[] {
  const extra = existingChoices(attachable, runtimes);
  return rows.map((r) => {
    if (r.actor === 'human') return r;
    const base = r.choices.filter((c) => c.kind !== 'existing');
    const choices = r.actor === 'either' ? [...base.filter((c) => c.kind === 'agent'), ...extra, ...base.filter((c) => c.kind === 'me')] : [...base, ...extra];
    const owner = r.owner.kind === 'existing' && !choices.some((c) => c.kind === 'existing' && c.agentId === (r.owner as { agentId: string }).agentId) ? choices[0] ?? r.owner : r.owner;
    return { ...r, choices, owner };
  });
}

/** The select's value for an owner (one value per choice). */
export function ownerKey(o: RowOwner): string { return o.kind === 'me' ? 'me' : o.kind === 'existing' ? `agent:${o.agentId}` : o.runtime; }

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
  /** null = a platform preset (named in the viewer's language by key — presetName); an organization's own recipe otherwise. */
  org_id?: string | null;
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

/** 에이전트에 묶인 줄이 하나도 없으면 시작할 수 없다. */
/** PO 10:40Z ② (Yuna 0747aadd v23): the default recipe — its first stage is an agent's, so the first task goes out right after
 * «시작» and a result shows. The platform preset only (an org's own recipe with this key is not it). */
export const DEFAULT_SETUP_RECIPE_KEY = 'preset.marketing.blog_article';

/** The list with the default recipe first when it is there (the rest keep the server's order); its first entry is the one chosen.
 * Not there (the organization turned it off) → the list as it came. No «recommended» mark — being first and chosen is all. */
export function withDefaultRecipeFirst<T extends Pick<SetupRecipe, 'key' | 'org_id'>>(recipes: readonly T[]): T[] {
  const i = recipes.findIndex((r) => r.key === DEFAULT_SETUP_RECIPE_KEY && r.org_id === null);
  return i < 0 ? [...recipes] : [recipes[i], ...recipes.slice(0, i), ...recipes.slice(i + 1)];
}

export function needsAnAgent(rows: readonly SetupRoleRow[]): boolean {
  // no row bound to an agent — agent rows with nothing found, or either rows all set to «나» (PO 05:21Z ⒜ · the server
  // refuses the same with no_agent_role: this setup exists to start agents on this device). A moved agent counts (4565).
  return !rows.some((r) => r.owner.kind === 'agent' || r.owner.kind === 'existing');
}

/** «에이전트 N개» — 새로 만들 에이전트 수(새 런타임을 고른 줄). 옮겨 오는 이미 있는 에이전트는 셈하지 않는다(4565). */
export function agentRowCount(rows: readonly SetupRoleRow[]): number {
  return rows.filter((r) => r.owner.kind === 'agent').length;
}

/** story #4565 — 이 컴퓨터로 옮겨 오는 이미 있는 에이전트 수. */
export function movedRowCount(rows: readonly SetupRoleRow[]): number {
  return rows.filter((r) => r.owner.kind === 'existing').length;
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
  /** `{role, runtime}` = a new agent · `{role, owner: 'me'}` = the person confirming holds an either row (PO 05:21Z ⒜) ·
   * `{role, agent_id}` = an existing agent moved to this computer (4565). Human rows are not sent (the server binds them). */
  roles: ({ role: string; runtime: DesktopRuntime } | { role: string; owner: 'me' } | { role: string; agent_id: string })[];
  workdir_hint: string;
}

/** 확인 요청(4424 confirm) — 에이전트가 맡는 역할마다 {role, runtime}(역할 하나 = 에이전트 하나), «나»를 고른 either 줄은
 * {role, owner: 'me'}. 사람만 맡는 줄은 싣지 않는다(BE가 확인을 누른 사람에게 묶는다 — PO 07:14Z). */
/** story 4496 — no project chosen and the organization has none: the same body with the first project's name instead of an id
 * (the server makes it with the setup — only when the organization really has no project, else 409 project_required). */
export function firstProjectConfirmBody(code: string, rows: readonly SetupRoleRow[], recipeId: string, workdirHint: string, projectName: string): Omit<ConfirmBody, 'project_id'> & { project_name: string } {
  const { project_id: _none, ...rest } = confirmBody(code, rows, '', recipeId, workdirHint);
  return { ...rest, project_name: projectName.trim() };
}

export function confirmBody(code: string, rows: readonly SetupRoleRow[], projectId: string, recipeId: string, workdirHint: string): ConfirmBody {
  return {
    code,
    project_id: projectId,
    recipe_id: recipeId,
    roles: rows.flatMap<ConfirmBody['roles'][number]>((r) => (r.owner.kind === 'agent' ? [{ role: r.role, runtime: r.owner.runtime }]
      // story #4565: an existing agent moved to this computer — its id; the server checks it is this org's and takes its runtime
      : r.owner.kind === 'existing' ? [{ role: r.role, agent_id: r.owner.agentId }]
        : r.actor === 'either' ? [{ role: r.role, owner: 'me' as const }] : [])),
    workdir_hint: workdirHint.trim(),
  };
}

/** (나) confirm-new-org's body (design doc 9a4cb445): the usual fields without a project, plus the new organization's and first
 * project's names. No organization or project id — the server only uses the ones it makes (extra=forbid). */
export interface NewOrgConfirmBody extends Omit<ConfirmBody, 'project_id'> { org_name: string; project_name: string }
export function newOrgConfirmBody(code: string, rows: readonly SetupRoleRow[], recipeId: string, workdirHint: string, orgName: string, projectName: string): NewOrgConfirmBody {
  const { project_id: _none, ...rest } = confirmBody(code, rows, '', recipeId, workdirHint);
  return { ...rest, org_name: orgName.trim(), project_name: projectName.trim() };
}

// ── story #4427 — 설정 값은 `#` 뒤로만 ──
// 설정 코드는 어떤 URL에도 싣지 않는다(까디르 4825 · PO 09:45Z): 앱이 `#` 뒤(fragment)로 넘기고 — 서버 요청 · 로그 · Referer에
// 안 남는다 — 페이지는 읽자마자 주소에서 지우고 메모리에만 둔다. 로그인을 거치면 `#`이 따라오지 않는데, 그때는 코드를 쥔
// 데스크톱 앱이 설정 페이지를 다시 연다(PO 09:58Z) — 웹은 코드를 맡아 두지 않는다.

/** The fragment the desktop app opens this page with, from the values the page holds — for a reload that must not lose them
 * (story 4429 ②). Only in the `#` (never a query: the address's `?` goes to servers and logs — PO 09:45Z). */
export function setupFragment(q: SetupQuery): string {
  const p = new URLSearchParams({ code: q.code, runtimes: q.runtimes.join(',') });
  if (q.setupId) p.set('setup', q.setupId);
  if (q.blocked.length) p.set('blocked', q.blocked.join(','));
  if (q.old?.length) p.set('old', q.old.map((o) => `${o.runtime}:${o.version}:${o.min}`).join(','));
  return `#${p.toString().replace(/%2C/g, ',')}`;
}

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
  /** The setup's recipe (org_id null = a platform preset) — named by its translation, as the recipe list names it (PO 10:39Z ①). */
  recipe?: { key: string; name: string | null; org_id: string | null } | null;
  work_item_id: string | null;
  members: { stage: string; role: string | null; member_id: string; kind: 'agent' | 'human'; runtime: DesktopRuntime | null }[];
  signals: {
    tools_connected: { member_id: string; at: string }[];
    first_task_handed_at: string | null;
    first_result_at: string | null;
    /** story 4468 — the agent that showed the first result (one of the setup's); null = not known (never guessed). */
    first_result_member_id?: string | null;
    workdir_fallback_at: string | null;
    blocked: { at: string; reason: string | null } | null;
    /** 디디군 이벤트 신뢰 PR에서 더해질 값 — 없으면 180초 쪽만 쓴다. */
    first_screen_human_input_at?: string | null;
    /** story 4433 — 에이전트마다 마지막 «첫 턴 전 끝남»(셸 desktop_agent_ended_early)과 마지막 «다시 시작»(desktop_agent_restarted).
     *  BE가 아직 안 싣는 칸 — 없으면 아무것도 안 바뀐다(디디 4844 뒤). */
    agents_ended?: { member_id: string; at: string; runtime: DesktopRuntime | null; exit_code: number | null; restarted_at?: string | null }[];
    /** story 4452 — 셸이 시작하지 못한 에이전트마다 마지막 보고(이유 · 데몬 code · 상한 · 기다린 첫 에이전트). 그 뒤 연결되거나
     *  다시 시작되면 BE가 뺀다. 없으면 아무것도 안 바뀐다. */
    agents_start_failed?: AgentStartFailure[];
  };
}

export type StartFailedReason = 'runtime_missing' | 'credentials_refused' | 'start_refused' | 'key_unreadable' | 'first_not_ready' | 'workdir_needed';
export interface AgentStartFailure {
  member_id: string; at: string; reason: StartFailedReason | null; code: string | null; runtime: DesktopRuntime | null;
  limit: number | null; first_member_id: string | null;
}

/** story 4452 (Yuna 04:41Z · 04:43Z) — which line of the reason table a failure gets: by the next thing to do, not by code. */
export type StartFailedLine = 'runtimeMissing' | 'runtimeDidNotStart' | 'credentials' | 'keyUnreadable' | 'firstNotReady'
  | 'sessionLimit' | 'notConnected' | 'workdirNeeded' | 'unknown';
export function startFailedLine(reason: StartFailedReason | null, code: string | null): StartFailedLine {
  if (reason === 'runtime_missing') return 'runtimeMissing';
  if (reason === 'key_unreadable') return 'keyUnreadable';
  if (reason === 'first_not_ready') return 'firstNotReady';
  // story #4565: an agent moved from elsewhere waits until its working folder is picked in the app
  if (reason === 'workdir_needed') return 'workdirNeeded';
  if (reason === 'credentials_refused') return 'credentials';
  if (reason === 'start_refused') {
    if (code === 'session_limit') return 'sessionLimit';
    if (code === 'credentials_missing') return 'credentials';
    if (code === 'not_connected') return 'notConnected';
    if (code === 'profile_invalid' || code === 'unknown_profile' || code === 'adapter_prepare_failed' || code === 'spawn_failed') return 'runtimeDidNotStart';
  }
  return 'unknown';
}

export type StepState = 'running' | 'done';
/** story 4492 (PO 07:06Z · Yuna 07:06Z): how a step is drawn — `waiting` = not started yet (an earlier step is not done): a still
 *  ring and its own words, never a spinner. */
export type StepShown = StepState | 'waiting';

/**
 * story 4492 — one spinner: the earliest step that is not done. At the first agent's gate (handed over, its tools not connected)
 * that is ① — the gate is part of getting the agents ready (`ready` = handed over + every agent's tools connected) — and ② · ③
 * wait. Three spinners read «just wait», which says the opposite of the note asking the person to answer.
 */
export function stepsShown(p: Pick<SetupProgress, 'readyDrawn' | 'handed' | 'result'>): [StepShown, StepShown, StepShown] {
  const states = [p.readyDrawn, p.handed, p.result] as const;
  const open = states.findIndex((s) => s !== 'done');
  return states.map((s, i) => (s === 'done' ? 'done' : i === open ? 'running' : 'waiting')) as [StepShown, StepShown, StepShown];
}
export const NOT_CONNECTED_AFTER_INPUT_MS = 30_000;
export const NOT_CONNECTED_AFTER_HANDOVER_MS = 180_000;

export interface SetupProgress {
  /** story 4464 — the one end condition for reading the status: blocked or expired, or the first result is in AND every agent is
   *  connected (or proven by that result). Before, the page stopped at the first result, so an agent that connected after it
   *  stayed «아직 준비하고 있어요» on screen (PO r8 0dbcd38e). PO 12:04Z (the 10:04Z rule was wrong): an agent that could not
   *  start, that stopped, or that ⑦ is about is NOT settled — the page shows a block asking the person to act ([다시 시도] ·
   *  [다시 시작] · trust the folder), and only further reading can take the block away once they did. */
  settled: boolean;
  /** the first result is in and a block waits for the person (an agent not connected yet) — the page reads less often then */
  waitingOnPerson: boolean;
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
  /** story 4452 (Yuna v32) — the agents ⑦ is about: started, not connected, not failed (roles in flow order) · `claude` = one of
   *  them is Claude Code (the trust sentence). With a start failure on the page ⑦ is a block among the others, not the card. */
  notConnectedAgents: { roles: string[]; runtimes: DesktopRuntime[]; claude: boolean };
  /** 받은 뒤 회사 설정으로 막힘(⑥ · 셸의 after_start 신호) → ⑥ 화면. */
  blocked: boolean;
  /** 코드가 먼저 끝나 앱이 받지 못함 → ④ 화면(앱에서 다시 시작). */
  expired: boolean;
  /**
   * story 4433 — 첫 결과 전에 멈춘 에이전트들(유나 정본: 세 단계 아래 한 덩어리 · 역할을 한 줄에 묶음). 끝남이 다시 시작보다 늦고
   * 그 뒤 첫 결과가 없는 에이전트만 · 없으면 null. `claude` = Claude Code가 섞임(다시 켜면 믿기를 다시 물을 수 있다는 둘째 문장).
   */
  stopped: { roles: string[]; claude: boolean } | null;
  /**
   * story 4433 (Yuna v29 · PO 15:59Z): a step spins only while something moves. ① gets the still ring when every agent not
   * connected yet is stopped; ② when the agent to receive the first task is stopped (③ as before: any stopped agent). A step
   * whose agents are only partly stopped keeps spinning; started again → back as it was. The words of the step stay.
   */
  readyPaused: boolean;
  handedPaused: boolean;
  /**
   * story 4433 (Yuna 12:22Z · PO 12:23Z) — how ① is drawn: a later step that is done means the earlier one is drawn done
   * (② proves the agent that received the task was ready). The definition of `ready` (every agent connected) does not change.
   */
  readyDrawn: StepState;
  /** The other agents still getting ready while ① is drawn done — roles in the flow's order (a stopped agent is only in `stopped`). */
  stillPreparing: string[];
  /** story 4452 — the agents the shell could not start (flow order · one per agent): role, runtime, the reason line and its
   *  values. Such an agent is in no other list (not «not connected», not «still getting ready»). */
  /** story 4498 — the setup was disconnected («연결 끊기» on the devices list): the end card, nothing of the steps. */
  disconnected: boolean;
  startFailed: { memberId: string; role: string | null; runtime: DesktopRuntime | null; line: StartFailedLine; limit: number | null; firstRole: string | null }[];
}

/** `handedOverSeenAt` = 이 페이지가 handed_over를 처음 본 때(상태 조회에 받은 시각이 없어 페이지 시계로 잰다). */
export function setupProgress(s: SetupStatus, now: number, handedOverSeenAt: number | null): SetupProgress {
  // a role name is trimmed once, here where the status is read — every place that shows it (stopped block · still getting
  // ready · ② detail · the pairs line) and the «에이전트» check see the same name (PO 16:41Z)
  const agents = s.members.filter((m) => m.kind === 'agent').map((m) => ({ ...m, role: m.role?.trim() || null }));
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
  const stoppedMembers = stoppedMemberIds(s);
  const stopped = stoppedAgents(stoppedMembers, s, agents);
  // story 4452 — an agent the shell could not start is not «not connected»: it never started. It gets its own block with its
  // reason; ⑦ and the trust note are only for an agent that started and has not connected (선생님 576b352b: one of three
  // refused at start took the whole progress over 30 s after a person's input)
  const failedRows = (s.signals.agents_start_failed ?? []).filter((f) => !connected.has(f.member_id));
  const failedIds = new Set(failedRows.map((f) => f.member_id));
  const startFailed = startFailedAgents(failedRows, agents);
  const pendingStarted = agentIds.filter((id) => !connected.has(id) && !failedIds.has(id));
  // a stopped agent says what to do itself (its block) — the trust note and ⑦ «not connected» would tell a different story
  const waitingForTools = handedOver && pendingStarted.length > 0 && result === 'running' && !stopped;
  const pastThreshold = (Number.isFinite(input) && now - input >= NOT_CONNECTED_AFTER_INPUT_MS)
    || (handedOverSeenAt !== null && now - handedOverSeenAt >= NOT_CONNECTED_AFTER_HANDOVER_MS);
  // story 4464 (Qadir 4880 · PO 10:04Z): after the first result an agent that started and never connects (no failure · not
  // stopped) gets the same threshold and the same ⑦ — as a block under the finished steps (the component: no covering card
  // once the result is in); it then counts as settled, so the reading stops instead of «아직 준비하고 있어요» forever
  // the first result proves the agent that showed it is connected (no signal needed — 결과가 연결의 증거). Which agent: the
  // server says (story 4468 · Qadir 4880 second line) — it was the flow's first agent guessed, and a result by another one
  // left that agent «proven» while it never connected. The server says null when it does not know → no one is proven; an older
  // server that does not send the field at all (undefined) keeps the old reading, the flow's first agent (AC1: compatible).
  const resultBy = s.signals.first_result_member_id;
  const proven = result !== 'done' ? null : resultBy === undefined ? agents[0]?.member_id ?? null : resultBy;
  const unsettled = pendingStarted.filter((id) => !stoppedMembers.has(id) && id !== proven);
  const lateNotConnected = handedOver && result === 'done' && unsettled.length > 0 && pastThreshold;
  const notConnected = (waitingForTools && pastThreshold) || lateNotConnected;
  // every agent connected, or proven by the first result — the one thing that ends the reading after the result (PO 12:04Z) —
  // and not stopped: an agent that connected and then stopped shows a [다시 시작] block that only further reading can take away
  // (PO 12:18Z: A stopped after the result · B connecting → B in → settled → A's block stayed after the person restarted A)
  const everyAgentIn = agentIds.every((id) => (connected.has(id) || id === proven) && !stoppedMembers.has(id));
  // who ⑦ names: before the result every agent not yet connected; after it, only the ones still unsettled
  const named = (id: string) => (lateNotConnected ? unsettled.includes(id) : pendingStarted.includes(id));
  return {
    ready, handed, result, pairs,
    // story 4498 (PO 10:50Z): a disconnected setup is an end like an expired one — the reading stops (it asked every 2 s forever)
    settled: !!s.signals.blocked || s.state === 'not_handed_over' || s.state === 'disconnected' || (result === 'done' && everyAgentIn),
    waitingOnPerson: !s.signals.blocked && s.state !== 'not_handed_over' && s.state !== 'disconnected' && result === 'done' && !everyAgentIn,
    firstAgentRole: agents.find((m) => m.role)?.role ?? null,
    workdirFallback: !!s.signals.workdir_fallback_at,
    trustHint: waitingForTools && !notConnected,
    notConnected,
    notConnectedAgents: {
      roles: [...new Set(agents.filter((m) => named(m.member_id) && m.role).map((m) => m.role as string))],
      runtimes: [...new Set(agents.filter((m) => named(m.member_id) && m.runtime).map((m) => m.runtime as DesktopRuntime))],
      claude: agents.some((m) => named(m.member_id) && m.runtime === 'claude'),
    },
    blocked: !!s.signals.blocked,
    expired: s.state === 'not_handed_over',
    disconnected: s.state === 'disconnected',
    stopped,
    readyPaused: !(ready === 'done' || handed === 'done') && agentIds.some((id) => !connected.has(id))
      && agentIds.filter((id) => !connected.has(id)).every((id) => stoppedMembers.has(id) || failedIds.has(id)),
    handedPaused: handed === 'running' && !!agents[0] && (stoppedMembers.has(agents[0].member_id) || failedIds.has(agents[0].member_id)),
    readyDrawn: ready === 'done' || handed === 'done' ? 'done' : 'running',
    // an agent past the threshold is said once, by the ⑦ block — never also «아직 준비하고 있어요» (PO 10:05Z)
    stillPreparing: ready === 'done' || handed !== 'done' || notConnected ? [] : stillPreparingRoles(agents, connected, stopped).filter((r) => !startFailed.some((f) => f.role === r)),
    startFailed,
  };
}

/** story 4452 — the failures in the flow's order (one per agent), with the role names the copy needs (the agent it waited on). */
function startFailedAgents(rows: AgentStartFailure[], agents: SetupStatus['members']): SetupProgress['startFailed'] {
  const out: SetupProgress['startFailed'] = [];
  const roleOf = (id: string | null) => (id ? agents.find((m) => m.member_id === id)?.role ?? null : null);
  for (const m of agents) {
    const f = rows.find((r) => r.member_id === m.member_id);
    if (!f || out.some((o) => o.memberId === m.member_id)) continue;
    out.push({
      memberId: m.member_id, role: m.role, runtime: f.runtime ?? m.runtime, line: startFailedLine(f.reason, f.code),
      limit: typeof f.limit === 'number' && f.limit > 0 ? f.limit : null, firstRole: roleOf(f.first_member_id),
    });
  }
  return out;
}

/** The agents not connected yet, by role (each once, the flow's order), leaving out the stopped ones (one agent, one place). */
function stillPreparingRoles(agents: SetupStatus['members'], connected: ReadonlySet<string>, stopped: SetupProgress['stopped']): string[] {
  const out: string[] = [];
  for (const m of agents) {
    if (connected.has(m.member_id) || !m.role || out.includes(m.role)) continue;
    if (stopped?.roles.includes(m.role)) continue;
    out.push(m.role);
  }
  return out;
}

/** 멈춘 에이전트(story 4433): 그 에이전트의 마지막 끝남이 마지막 다시 시작보다 늦고(또는 다시 시작 없음), 그 뒤 첫 결과가 없을 때. */
function stoppedMemberIds(s: SetupStatus): Set<string> {
  const out = new Set<string>();
  const result = s.signals.first_result_at ? Date.parse(s.signals.first_result_at) : NaN;
  for (const e of s.signals.agents_ended ?? []) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) continue;
    const restarted = e.restarted_at ? Date.parse(e.restarted_at) : NaN;
    if (Number.isFinite(restarted) && restarted >= at) continue; // started again after it stopped
    if (Number.isFinite(result) && result >= at) continue; // a first result came after it
    out.add(e.member_id);
  }
  return out;
}

function stoppedAgents(out: ReadonlySet<string>, s: SetupStatus, agents: SetupStatus['members']): SetupProgress['stopped'] {
  if (out.size === 0) return null;
  const roles: string[] = [];
  let claude = (s.signals.agents_ended ?? []).some((e) => out.has(e.member_id) && e.runtime === 'claude');
  // the roles in the flow's order, each once (a role over several stages is one role)
  for (const m of agents) if (out.has(m.member_id) && m.role && !roles.includes(m.role)) roles.push(m.role);
  if (agents.some((m) => out.has(m.member_id) && m.runtime === 'claude')) claude = true;
  return { roles, claude };
}

/**
 * story 4433 (Yuna v29): a role name that already ends in «에이전트» (ko) — or «agent» / «에이전트» (en, any case) — gets no
 * «에이전트» / «agent» added after it (never «에이전트 에이전트»). For a group of roles, the last one decides.
 */
export function endsWithAgentWord(name: string, locale: string): boolean {
  const n = name.trim();
  return locale === 'ko' ? /에이전트$/.test(n) : /(agent|에이전트)$/i.test(n);
}

/** 폴링 간격(PO 12:25Z). 끝 조건은 setupProgress().settled 하나(story 4464): 막힘 · 만료, 또는 첫 결과 뒤 모든 에이전트가 붙음. */
export const SETUP_STATUS_POLL_MS = 2_000;
/** story 4464 (PO 12:04Z): a block waiting for the person since the first result came over 2 minutes ago → read every 10 s
 *  (not stopped — when they act and the agent connects, the block goes; a longer gap, never a fixed sleep). */
export const SETUP_STATUS_SLOW_POLL_MS = 10_000;
export const SETUP_STATUS_SLOW_AFTER_MS = 120_000;
/** How long until the next reading: the usual 2 s, or 10 s while a block has waited for the person for a while. */
export function setupPollDelayMs(p: Pick<SetupProgress, 'waitingOnPerson'>, firstResultAt: string | null, now: number): number {
  const since = firstResultAt ? now - Date.parse(firstResultAt) : NaN;
  return p.waitingOnPerson && Number.isFinite(since) && since >= SETUP_STATUS_SLOW_AFTER_MS ? SETUP_STATUS_SLOW_POLL_MS : SETUP_STATUS_POLL_MS;
}
