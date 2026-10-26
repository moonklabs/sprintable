// story 4711 — 처음 셋업 세 걸음(에이전트 → 폴더 → 시작)의 순수 규칙. 화면 · 글은 유나 `yuna/4711-copy-1016.md`, 서버는 confirm-solo(PR 5120).
// 폴더 고르기는 앱의 맥 폴더 창이 한다(웹은 못 고른다) — 앱이 고른 결과를 주소의 `#` 조각으로 되돌려 열고, 웹은 «이름»만 서버에 보낸다(경로 0).
import { DESKTOP_RUNTIMES, SOLO_TRACE_RUNTIME, isFolderRefused, type DesktopRuntime, type FolderRefusal, type SetupQuery, type SoloFolder, type SoloTraceFile } from './desktop-setup';

/** The agent the card picks without being asked: the person's earlier pick (echoed by the app after the folder window) if it is still
 *  usable, else the first usable one in the fixed order (Claude Code → Codex). None usable → null (the card shows the no-agent block). */
export function defaultSoloRuntime(usable: readonly DesktopRuntime[], pick?: DesktopRuntime): DesktopRuntime | null {
  if (pick && usable.includes(pick)) return pick;
  return DESKTOP_RUNTIMES.find((r) => usable.includes(r)) ?? null;
}

/** story 4713 AC2: the mark the folder carries whose program this card can offer — the first of the OFFERED programs (their order is the app's found order,
 *  the rule the recruiter's card uses) that has a mark in the folder. None offered has a mark → null (no pick, and no line: never a word about something not done). */
export function folderTracePick(folder: SoloFolder | undefined, usable: readonly DesktopRuntime[]): { file: SoloTraceFile; runtime: DesktopRuntime } | null {
  for (const runtime of usable) {
    const file = folder?.traces?.find((f) => SOLO_TRACE_RUNTIME[f] === runtime);
    if (file) return { file, runtime };
  }
  return null;
}

/** The runtimes the card may offer: found, and not one the company's managed MCP policy blocks (⑥). */
export function usableRuntimes(q: Pick<SetupQuery, 'runtimes' | 'blocked'>): DesktopRuntime[] {
  return q.runtimes.filter((r) => !q.blocked.includes(r));
}

/** story 4784: what the person saw on the «에이전트 만들기» card and pressed «만들기» on — the name (never blank), the role (blank = none, left out) and the
 *  folder's NAME (never a path; it only goes into the room's first line). */
export interface AgentMade { name: string; role: string }
export interface SoloConfirmBody {
  code: string;
  runtime: DesktopRuntime;
  /** exactly one of the two: the project the app found for this folder, or the folder's name (a new project) */
  project_id?: string;
  project_name?: string;
  agent_name: string;
  agent_role?: string;
  folder_name: string;
}
export interface SoloNewOrgConfirmBody { code: string; runtime: DesktopRuntime; org_name: string; project_name: string; agent_name: string; agent_role?: string; folder_name: string }

/** The agent's name and role as the server takes them: trimmed; a blank role is left out. */
function madeFields(made: AgentMade): { agent_name: string; agent_role?: string } {
  const role = made.role.trim();
  return { agent_name: made.name.trim(), ...(role ? { agent_role: role } : {}) };
}

/** The confirm-solo body. `useProject`: the person's [넣고 만들기] (the free plan's one project) — that project, not a new one. */
export function soloConfirmBody(code: string, runtime: DesktopRuntime, folder: SoloFolder, made: AgentMade, useProject?: string): SoloConfirmBody {
  const project = useProject ?? folder.projectId;
  const agent = { ...madeFields(made), folder_name: folder.name };
  return project ? { code, runtime, project_id: project, ...agent } : { code, runtime, project_name: folder.name, ...agent };
}

export function soloNewOrgConfirmBody(code: string, runtime: DesktopRuntime, folder: SoloFolder, orgName: string, made: AgentMade): SoloNewOrgConfirmBody {
  return { code, runtime, org_name: orgName, project_name: folder.name, ...madeFields(made), folder_name: folder.name };
}

/** The most the server takes (backend AGENT_NAME_MAX · AGENT_ROLE_MAX) — the card's fields stop there instead of answering 422. */
export const AGENT_NAME_MAX = 60;
export const AGENT_ROLE_MAX = 200;

/** story 4784: the folder window reloads this page (the answer comes back in a new address), so what the person typed for the new agent waits in the
 *  tab's session storage, per setup, and is read back once on mount. Only the two fields they typed; unreadable or absent storage = nothing kept. */
const TYPED_KEY = 'sprintable.desktopSetupQuick.typed.v1:'; // + the setup id: two setups (tabs) never share or overwrite a draft
export function readTypedAgent(setupId: string | null): { name: string | null; role: string } {
  try {
    const raw = setupId ? window.sessionStorage.getItem(TYPED_KEY + setupId) : null;
    const v = raw ? JSON.parse(raw) as { name?: unknown; role?: unknown } : null;
    if (!v) return { name: null, role: '' };
    return { name: typeof v.name === 'string' ? v.name.slice(0, AGENT_NAME_MAX) : null, role: typeof v.role === 'string' ? v.role.slice(0, AGENT_ROLE_MAX) : '' };
  } catch { return { name: null, role: '' }; }
}
export function writeTypedAgent(setupId: string | null, name: string | null, role: string): void {
  try {
    if (!setupId) return;
    if (name === null && !role) window.sessionStorage.removeItem(TYPED_KEY + setupId);
    else window.sessionStorage.setItem(TYPED_KEY + setupId, JSON.stringify({ name, role }));
  } catch { /* storage closed: the fields just start over after the folder window */ }
}

/** The project name the card shows for a NEW project: the folder's name, or «{name} 2» · «{name} 3» … when the organization has it —
 *  the server makes the final name by the same rule (compatibility-folded · format characters dropped · spaces collapsed · case ignored; the base is cut so the
 *  name stays within 100 characters); this is only what the line says before. */
export function shownProjectName(name: string, taken: readonly string[]): string {
  const norm = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
  const used = new Set(taken.map(norm));
  let n = 1;
  let candidate = name;
  while (used.has(norm(candidate))) { n += 1; const tail = ` ${n}`; candidate = `${name.slice(0, Math.max(100 - tail.length, 0))}${tail}`; }
  return candidate;
}

/** The ready state of the card: what [시작] needs, and the one visible reason when it is off (Yuna: never a tooltip). */
export type SoloBlock = 'no-agent' | 'no-folder' | 'wide-unconfirmed' | null;
export function soloStartBlock(runtime: DesktopRuntime | null, folder: SoloFolder | undefined, wideConfirmed: boolean): SoloBlock {
  if (!runtime) return 'no-agent';
  if (!folder) return 'no-folder';
  if (folder.wide && !wideConfirmed) return 'wide-unconfirmed';
  return null;
}

/** Yuna §6: the folder refusals that come back from the app's window → the card's line (the keys are in `desktop.setup.quick.refused`). */
export const REFUSAL_LINE: Record<FolderRefusal, 'denied' | 'missing' | 'app_folder' | 'not_folder'> = {
  denied: 'denied', missing: 'missing', app_folder: 'app_folder', not_folder: 'not_folder',
};

/** The card's agent-limit / project-limit / other 402 and refusals from confirm-solo → what the card does (a closed list; anything
 *  outside it is the generic «시작하지 못했어요»). */
export type SoloOutcome =
  | { kind: 'agent-limit'; counts: { needed?: number; available?: number } }
  | { kind: 'use-existing-project'; project: { id: string; name: string } }
  | { kind: 'project-limit' }
  | { kind: 'not-admin' }
  | { kind: 'expired' }
  | { kind: 'app-cannot' }
  | { kind: 'has-org' }
  | { kind: 'pending-invites' }
  | { kind: 'email-verify' }
  | { kind: 'name-taken'; suggested: string | null }
  | { kind: 'bad-text'; field: 'agent_name' | 'agent_role'; blank: boolean }
  | { kind: 'rate-limited'; retryAfter: number | null }
  | { kind: 'generic' };

interface ErrorBody { code?: string; resource?: string; needed?: unknown; available?: unknown; existing_project?: { id?: unknown; name?: unknown }; suggested_name?: unknown }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** story 4784 (Kadir 5245): the server refuses a typed name/role it cannot show as one honest line (422, FastAPI's `detail` list: `loc: ['body', field]`, `msg`).
 *  The card says WHICH field and why instead of a «try again» that could never work. null = a 422 that is not about those two fields. */
function badTextOf(detail: unknown): { field: 'agent_name' | 'agent_role'; blank: boolean } | null {
  if (!Array.isArray(detail)) return null;
  for (const item of detail) {
    const loc = (item as { loc?: unknown } | null)?.loc;
    const field = Array.isArray(loc) ? loc[1] : null;
    if (field === 'agent_name' || field === 'agent_role') {
      const msg = (item as { msg?: unknown }).msg;
      return { field, blank: typeof msg === 'string' && msg.includes('must not be blank') };
    }
  }
  return null;
}

export function soloOutcome(status: number, error: ErrorBody | undefined, retryAfterHeader: string | null, detail?: unknown): SoloOutcome {
  if (status === 422) {
    const bad = badTextOf(detail);
    if (bad) return { kind: 'bad-text', ...bad };
  }
  if (status === 429 || error?.code === 'RATE_LIMITED') {
    const secs = Number(retryAfterHeader);
    return { kind: 'rate-limited', retryAfter: Number.isFinite(secs) && secs > 0 ? secs : null };
  }
  switch (error?.code) {
    case 'PLAN_LIMIT_EXCEEDED': {
      if (error.resource === 'agent') {
        const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
        return { kind: 'agent-limit', counts: { needed: n(error.needed), available: n(error.available) } };
      }
      if (error.resource === 'project') {
        const p = error.existing_project;
        return typeof p?.id === 'string' && UUID.test(p.id) && typeof p.name === 'string' && p.name
          ? { kind: 'use-existing-project', project: { id: p.id, name: p.name } } : { kind: 'project-limit' };
      }
      return { kind: 'generic' };
    }
    case 'not_org_admin':
    case 'person_session_required': return { kind: 'not-admin' };
    case 'code_expired':
    case 'code_used': return { kind: 'expired' };
    case 'app_cannot_solo': return { kind: 'app-cannot' };
    case 'has_organization': return { kind: 'has-org' };
    case 'pending_invites': return { kind: 'pending-invites' };
    case 'EMAIL_VERIFICATION_REQUIRED': return { kind: 'email-verify' };
    case 'agent_name_taken': return { kind: 'name-taken', suggested: typeof error.suggested_name === 'string' && error.suggested_name.trim() ? error.suggested_name.trim().slice(0, AGENT_NAME_MAX) : null };
    default: return { kind: 'generic' };
  }
}

/** Whether the page shows this card (not the recipe setup): the app said it can, no recruiter's agent (`agent=` keeps today's page until
 *  its own branch), and the person has not asked for the team path. */
export function showsQuickCard(q: SetupQuery, teamPath: boolean): boolean {
  return q.canSolo === true && !teamPath;
}

export { isFolderRefused };
