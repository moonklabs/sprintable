// story 4983 (P5 · layer 5) — the phone app lists a PROJECT's folder on the person's own computer.
//
// The web names three things — the computer (`setup_id`), the project (`project_id`) and a folder as a list of single NAMES it was given by an earlier answer — and the press's own key.
// Everything else is the shell's and the computer's: the shell (`files.seal`) checks the pick against its own read of the server, seals the request to the computer it pinned and signs it
// (an OS prompt, once per request); the web posts that sealed envelope and follows the command to the computer's sealed answer, which only the shell can open (`files.open`). The server
// holds both unread. No path ever goes from here: a folder is names, and the computer decides which folder of its own a project is. «Not known» is never said as «refused»: an end the web
// cannot see is `timeout`.
//
// What a refusal says is a closed word of the contract (contracts/file-browse-vectors.json `reasons`); the screen writes the sentence.

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

/** the closed words a computer's refusal ends in (the mobile repository's contract `reasons`) */
export const FILE_REASONS = [
  'not_enabled', 'no_folder', 'not_found', 'is_link', 'hidden_name', 'looks_secret', 'too_big', 'not_text', 'not_plain',
  'multi_linked', 'other_device', 'changed_while_reading', 'busy', 'timeout', 'denied', 'unsupported',
] as const;
export type FilesReason = (typeof FILE_REASONS)[number];

/** `k`: f = file · d = folder · l = link (shown, never followed) · o = anything else. `s` = bytes (files) · `t` = modified time, whole seconds since 1970 */
export interface FileEntry { n: string; k: 'f' | 'd' | 'l' | 'o'; s?: number; t?: number }
export interface FilesList { entries: FileEntry[]; hidden: number; more: boolean; cursor?: string }

export type FilesOutcome =
  | { kind: 'list'; list: FilesList }
  | { kind: 'reason'; reason: FilesReason }
  | { kind: 'cancelled' }
  /** the phone cannot confirm (no lock · key changed · not registered): the shell's own code says which */
  | { kind: 'key'; code: string }
  | { kind: 'needs_update' }
  | { kind: 'remote_off' }
  | { kind: 'unreachable' }
  | { kind: 'not_paired' }
  | { kind: 'no_folder' }
  | { kind: 'not_allowed' }
  | { kind: 'busy' }
  /** a name the computer will not take (or a folder too deep): nothing was asked */
  | { kind: 'unsupported' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

export interface FilesDeps {
  phoneCall: (type: string, args?: Record<string, unknown>) => Promise<PhoneAnswer>;
  newKey: () => string;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  pollMaxMs?: number;
  /** true once the screen is gone or a newer ask replaced this one: nothing more is asked or drawn */
  stopped?: () => boolean;
}

/** how often the answer is looked for (the server pauses a look that comes sooner than half a second) */
export const FILES_POLL_MS = 1_000;
/** the computer's own deadline is 15 s; its queue and the server's 30 s for a request that waited are on top */
export const FILES_POLL_MAX_MS = 60_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** the shell can do this at all: `shell.caps` says `files: 1` (read, never guessed from a version) */
export async function shellTakesFiles(phoneCall: FilesDeps['phoneCall']): Promise<boolean> {
  const caps = await phoneCall('shell.caps', {}).catch(() => null);
  return !!caps && caps.ok === true && isObj(caps.caps) && (caps.caps as { files?: unknown }).files === 1;
}

// the shell's refusal words → what the screen says (a word the shell has and this table has not is `failed`: nothing was asked)
const SHELL_CODES: Record<string, FilesOutcome> = {
  cancelled: { kind: 'cancelled' },
  remote_control_off: { kind: 'remote_off' },
  device_unreachable: { kind: 'unreachable' },
  computer_not_found: { kind: 'not_paired' },
  host_not_pinned: { kind: 'not_paired' },
  host_not_sealing: { kind: 'not_paired' },
  no_folder: { kind: 'no_folder' },
  busy: { kind: 'busy' },
  bad_request: { kind: 'unsupported' },
  too_long: { kind: 'unsupported' },
};
const KEY_CODES = new Set(['biometric_required', 'no_screen_lock', 'key_invalidated', 'key_failed', 'no_key', 'not_registered']);

function fromShell(code: string): FilesOutcome {
  if (KEY_CODES.has(code)) return { kind: 'key', code };
  return SHELL_CODES[code] ?? { kind: 'failed' };
}

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; detail?: { code?: string }; code?: string };
    return body.error?.code ?? body.detail?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

/** a refusal of the server's ask (nothing was made) → what the screen says */
function fromServer(status: number, code: string): FilesOutcome {
  if (code === 'files_busy' || code === 'files_too_fast') return { kind: 'busy' };
  if (code === 'device_unreachable') return { kind: 'unreachable' };
  if (code.startsWith('remote_control')) return { kind: 'remote_off' };
  if (code === 'phone_not_paired') return { kind: 'not_paired' };
  if (code === 'project_not_found') return { kind: 'no_folder' };
  if (status === 403 || code === 'not_allowed_to_read_files') return { kind: 'not_allowed' };
  return { kind: 'failed' };
}

/** a body the computer sealed, checked once more here (the shell already did: the web draws only what has this shape) */
export function parseList(body: unknown): FilesOutcome {
  if (!isObj(body) || body.v !== 1 || body.kind !== 'list' || typeof body.ok !== 'boolean') return { kind: 'failed' };
  if (body.ok === false) {
    return typeof body.reason === 'string' && (FILE_REASONS as readonly string[]).includes(body.reason) ? { kind: 'reason', reason: body.reason as FilesReason } : { kind: 'failed' };
  }
  if (!Array.isArray(body.entries) || typeof body.hidden !== 'number' || typeof body.more !== 'boolean') return { kind: 'failed' };
  const entries: FileEntry[] = [];
  for (const e of body.entries) {
    if (!isObj(e) || typeof e.n !== 'string' || (e.k !== 'f' && e.k !== 'd' && e.k !== 'l' && e.k !== 'o')) return { kind: 'failed' };
    entries.push({ n: e.n, k: e.k, ...(typeof e.s === 'number' ? { s: e.s } : {}), ...(typeof e.t === 'number' ? { t: e.t } : {}) });
  }
  return { kind: 'list', list: { entries, hidden: body.hidden, more: body.more, ...(typeof body.cursor === 'string' ? { cursor: body.cursor } : {}) } };
}

/**
 * One folder list: the shell seals and signs (the person confirms on the OS prompt) → the web posts the envelope → the web looks for the sealed answer → the shell opens it.
 * `dir` is the folder as single names (empty = the top of the project); `cursor` asks the next page of the same folder.
 */
export async function listFolder(input: { setupId: string; projectId: string; dir: string[]; cursor?: string }, deps: FilesDeps): Promise<FilesOutcome> {
  const key = deps.newKey();
  const stopped = deps.stopped ?? (() => false);
  const sealed = await deps.phoneCall('files.seal', {
    setup_id: input.setupId, project_id: input.projectId, dir: input.dir, idempotency_key: key, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  });
  if (!sealed.ok) return fromShell(sealed.code ?? '');
  if (!isObj(sealed.envelope) || typeof sealed.phone_key_id !== 'string' || sealed.idempotency_key !== key) return { kind: 'failed' };
  if (stopped()) return { kind: 'cancelled' };

  // the ask: the envelope and the ids — no name, no path
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/desktop/computers/${input.setupId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: input.projectId, idempotency_key: key, phone_key_id: sealed.phone_key_id, envelope: sealed.envelope }),
    });
  } catch {
    return { kind: 'timeout' }; // the ask may have reached the server: never said as «refused»
  }
  if (!res.ok) {
    if (res.status >= 500) return { kind: 'timeout' };
    return fromServer(res.status, await codeOf(res));
  }
  let made: { command_id?: unknown };
  try { made = (await res.json()) as typeof made; } catch { return { kind: 'timeout' }; }
  if (typeof made.command_id !== 'string') return { kind: 'timeout' };

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.pollMaxMs ?? FILES_POLL_MAX_MS);
  while (now() < deadline) {
    await wait(deps.pollMs ?? FILES_POLL_MS);
    if (stopped()) return { kind: 'cancelled' };
    let r: { state?: unknown; code?: unknown; envelope?: unknown };
    try {
      const got = await fetchWithAuth(`/api/desktop/computers/${input.setupId}/files/${made.command_id}`);
      if (got.status === 404) return { kind: 'timeout' }; // the row ended (its ten minutes · a disconnect): nothing more will come
      if (!got.ok) continue; // a look that failed is not an end (a paused one — «too fast» — is asked again)
      r = (await got.json()) as typeof r;
    } catch {
      continue;
    }
    if (isObj(r.envelope)) {
      const opened = await deps.phoneCall('files.open', { setup_id: input.setupId, project_id: input.projectId, idempotency_key: key, envelope: r.envelope });
      if (!opened.ok) return { kind: 'failed' };
      return parseList(opened.body);
    }
    // the computer ended without an answer: its own closed word is the end (never an answer's content)
    if (r.state === 'rejected' || r.state === 'failed') return r.code === 'expired' ? { kind: 'timeout' } : { kind: 'failed' };
    if (r.state === 'done') return { kind: 'failed' }; // done with no answer to read
  }
  return { kind: 'timeout' };
}
