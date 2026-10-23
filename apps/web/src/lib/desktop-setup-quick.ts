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

export interface SoloConfirmBody {
  code: string;
  runtime: DesktopRuntime;
  /** exactly one of the two: the project the app found for this folder, or the folder's name (a new project) */
  project_id?: string;
  project_name?: string;
}
export interface SoloNewOrgConfirmBody { code: string; runtime: DesktopRuntime; org_name: string; project_name: string }

/** The confirm-solo body. `useProject`: the person's [넣고 시작] (the free plan's one project) — that project, not a new one. */
export function soloConfirmBody(code: string, runtime: DesktopRuntime, folder: SoloFolder, useProject?: string): SoloConfirmBody {
  const project = useProject ?? folder.projectId;
  return project ? { code, runtime, project_id: project } : { code, runtime, project_name: folder.name };
}

export function soloNewOrgConfirmBody(code: string, runtime: DesktopRuntime, folder: SoloFolder, orgName: string): SoloNewOrgConfirmBody {
  return { code, runtime, org_name: orgName, project_name: folder.name };
}

/** The project name the card shows for a NEW project: the folder's name, or «{name} 2» · «{name} 3» … when the organization has it —
 *  the server makes the final name by the same rule (case-insensitive · trimmed); this is only what the line says before. */
export function shownProjectName(name: string, taken: readonly string[]): string {
  const norm = (s: string) => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
  const used = new Set(taken.map(norm));
  let n = 1;
  let candidate = name;
  while (used.has(norm(candidate))) { n += 1; candidate = `${name} ${n}`; }
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
  | { kind: 'rate-limited'; retryAfter: number | null }
  | { kind: 'generic' };

interface ErrorBody { code?: string; resource?: string; needed?: unknown; available?: unknown; existing_project?: { id?: unknown; name?: unknown } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function soloOutcome(status: number, error: ErrorBody | undefined, retryAfterHeader: string | null): SoloOutcome {
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
    default: return { kind: 'generic' };
  }
}

/** Whether the page shows this card (not the recipe setup): the app said it can, no recruiter's agent (`agent=` keeps today's page until
 *  its own branch), and the person has not asked for the team path. */
export function showsQuickCard(q: SetupQuery, teamPath: boolean): boolean {
  return q.canSolo === true && !teamPath;
}

export { isFolderRefused };
