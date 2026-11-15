/**
 * story 4951 ①c — the changed-file LIST of an agent session's folder, from the computer of the person who paired it (server: PR ①a · `desktop_changes`).
 * Names · a status word · line counts, never content. This file is the part of the screen that is not drawing: ask, look until it answers, keep what came.
 *
 *  - ASK: `POST /api/agents/{id}/desktop-changes {session_key}` → `{command_id, expires_at}`. The server says no (403 · 409 · 429) in closed words.
 *  - LOOK: `GET …/desktop-changes/{command_id}`: a pending read is looked at ONCE A SECOND at most (the server holds 429 `changes_polled_too_fast` otherwise).
 *    The first successful look TAKES the list: the server deletes it on reading, so the list is kept here and never asked for again; a 404 after
 *    that — a response that got lost, a read that expired — is not an error to show as a fault but a «다시 불러오기» (a new ask; the server's 3 s pause between asks).
 *  - Nothing here knows a path or a file's content. A hidden row (a sensitive name) arrives with no name at all and is drawn as such.
 */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechange';

export interface ChangedFile {
  status: ChangeStatus;
  /** null for a hidden row (the computer and the server do not send the name of a sensitive file) */
  name: string | null;
  old_name: string | null;
  adds: number | null;
  dels: number | null;
  binary: boolean;
  hidden: boolean;
}

/** the closed words a read can end with — the computer's (`code` of a failed read) and the server's refusals; the screen writes the sentence */
export type ChangesProblem =
  | 'not_allowed' | 'unreachable' | 'remote_off' | 'busy' | 'too_fast' | 'session_gone' | 'expired'
  | 'no_folder' | 'not_a_repo' | 'not_repo_root' | 'unsafe_repo_config' | 'unsupported_repo' | 'state_inside' | 'git_missing' | 'timeout' | 'upload_failed' | 'failed';

export type ChangesState =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'waiting'; commandId: string; since: number }
  | { kind: 'ready'; files: ChangedFile[]; more: boolean; total: number; at: number }
  | { kind: 'problem'; problem: ChangesProblem; /** a new ask may help (the line says «다시 불러오기») */ retry: boolean };

export interface ChangesDeps {
  /** the web's own paths (the BFF routes of the ask and of the look) — the caller owns them, so no `/api/…` literal lives here (verify:no-new-raw-fetch-api) */
  paths: { ask: (agentId: string) => string; look: (agentId: string, commandId: string) => string };
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** waits `ms` (a timer in the screen; a controllable one in tests) — resolves false when cancelled */
  sleep: (ms: number) => Promise<boolean>;
}

/** a look at a pending read is never closer than this to the last (the server answers 429 below one second) */
export const POLL_MS = 1_100;
/** the server's row lives 120 s; looking stops a little before the server would say so */
export const GIVE_UP_MS = 115_000;
/** after a refused ask `changes_too_fast` the person may press again after this (the server's pause is 3 s) */
export const RETRY_PAUSE_MS = 3_100;

const FILE_STATUSES: ReadonlySet<string> = new Set(['added', 'modified', 'deleted', 'renamed', 'untracked', 'conflicted', 'typechange']);

/** what the server sent for a file, kept only if it has the shape — a row of a kind this page does not know is shown as «modified» (never dropped, never invented) */
export function normalizeFile(raw: unknown): ChangedFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const hidden = r.hidden === true;
  const status = typeof r.status === 'string' && FILE_STATUSES.has(r.status) ? (r.status as ChangeStatus) : 'modified';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const name = hidden ? null : typeof r.name === 'string' ? r.name : null;
  if (!hidden && name === null) return null;
  return {
    status, name, old_name: hidden ? null : typeof r.old_name === 'string' ? r.old_name : null,
    adds: hidden ? null : num(r.adds), dels: hidden ? null : num(r.dels), binary: !hidden && r.binary === true, hidden,
  };
}

/** the server's refusal / the computer's code → one of the closed words */
export function problemOf(httpStatus: number, code: string | undefined): { problem: ChangesProblem; retry: boolean } {
  const c = code ?? '';
  if (httpStatus === 403 || c === 'not_allowed_to_read_changes') return { problem: 'not_allowed', retry: false };
  if (c === 'device_unreachable') return { problem: 'unreachable', retry: true };
  if (c === 'remote_control_off') return { problem: 'remote_off', retry: false };
  if (c === 'changes_busy' || c === 'busy') return { problem: 'busy', retry: true }; // the server's «one read at a time on that computer» and the computer's own «busy»
  if (httpStatus === 429 || c === 'changes_too_fast') return { problem: 'too_fast', retry: true };
  if (httpStatus === 404 && (c === 'session_not_found' || c === 'agent_not_found')) return { problem: 'session_gone', retry: false };
  if (c === 'no_folder') return { problem: 'no_folder', retry: false };
  if (c === 'not_a_repo') return { problem: 'not_a_repo', retry: false };
  if (c === 'not_repo_root') return { problem: 'not_repo_root', retry: false };
  if (c === 'unsafe_repo_config') return { problem: 'unsafe_repo_config', retry: false };
  if (c === 'unsupported_repo') return { problem: 'unsupported_repo', retry: false };
  if (c === 'state_inside') return { problem: 'state_inside', retry: false }; // the session's folder holds the app's own data folder (a wide folder such as home): said, not read
  if (c === 'git_missing') return { problem: 'git_missing', retry: false };
  if (c === 'timeout') return { problem: 'timeout', retry: true };
  if (c === 'upload_failed') return { problem: 'upload_failed', retry: true };
  return { problem: 'failed', retry: true };
}

const errorCode = async (res: Response): Promise<string | undefined> => {
  try { const j = await res.json() as { error?: { code?: string } }; return j?.error?.code; } catch { return undefined; }
};

/**
 * ask for the list and follow it to its end. `onState` is told every change (the screen draws it); the returned promise resolves when the read has an end
 * (ready · problem) or was cancelled. `cancelled()` is asked between steps — a closed sheet stops looking.
 */
export async function loadChanges(
  { agentId, sessionKey }: { agentId: string; sessionKey: string },
  deps: ChangesDeps,
  onState: (s: ChangesState) => void,
  cancelled: () => boolean,
): Promise<void> {
  onState({ kind: 'asking' });
  let commandId: string;
  try {
    const res = await deps.fetch(deps.paths.ask(agentId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_key: sessionKey }),
    });
    if (cancelled()) return;
    if (!res.ok) { const { problem, retry } = problemOf(res.status, await errorCode(res)); onState({ kind: 'problem', problem, retry }); return; }
    const body = await res.json() as { command_id?: string };
    if (typeof body.command_id !== 'string' || body.command_id === '') { onState({ kind: 'problem', problem: 'failed', retry: true }); return; }
    commandId = body.command_id;
  } catch {
    if (!cancelled()) onState({ kind: 'problem', problem: 'failed', retry: true });
    return;
  }
  const since = deps.now();
  onState({ kind: 'waiting', commandId, since });
  for (;;) {
    if (!(await deps.sleep(POLL_MS)) || cancelled()) return;
    if (deps.now() - since > GIVE_UP_MS) { onState({ kind: 'problem', problem: 'expired', retry: true }); return; }
    let res: Response;
    try { res = await deps.fetch(deps.paths.look(agentId, commandId), { cache: 'no-store' }); } catch { continue; } // a hiccup: look again
    if (cancelled()) return;
    if (res.status === 429) { await res.body?.cancel().catch(() => {}); continue; } // looked too soon: the next look waits its turn
    if (res.status === 404) { onState({ kind: 'problem', problem: 'expired', retry: true }); return; } // taken already, expired, or no longer this person's — a new ask is the way
    if (!res.ok) { const { problem, retry } = problemOf(res.status, await errorCode(res)); onState({ kind: 'problem', problem, retry }); return; }
    let j: { state?: string; code?: string | null; files?: unknown[] | null; more?: boolean; total?: number };
    try {
      const parsed: unknown = await res.json();
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      j = parsed as typeof j;
    } catch {
      // an answer that is not JSON (or not an object) ends the read as «failed», retryable — never a sheet stuck on «waiting» (codex ①c r1 #3)
      if (!cancelled()) onState({ kind: 'problem', problem: 'failed', retry: true });
      return;
    }
    if (Array.isArray(j.files)) {
      const files = j.files.map(normalizeFile).filter((f): f is ChangedFile => f !== null);
      onState({ kind: 'ready', files, more: j.more === true, total: typeof j.total === 'number' ? j.total : files.length, at: deps.now() });
      return;
    }
    if (j.state === 'failed' || j.state === 'rejected') {
      const { problem, retry } = problemOf(200, j.code ?? undefined);
      onState({ kind: 'problem', problem: j.state === 'rejected' && j.code === 'expired' ? 'expired' : problem, retry });
      return;
    }
    if (j.state === 'done') { onState({ kind: 'ready', files: [], more: false, total: 0, at: deps.now() }); return; } // the computer ended without a list: nothing to show
    // still pending (queued · delivered · acked): look again
  }
}
