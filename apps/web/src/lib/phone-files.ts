// story 4983 (P5 · layer 5 · P6) — the phone app lists a PROJECT's folder on the person's own computer, and (P6) opens one file of it: its text or a small picture.
//
// The web names three things — the computer (`setup_id`), the project (`project_id`) and a folder as a list of single NAMES it was given by an earlier answer — and the press's own key.
// Everything else is the shell's and the computer's: the shell (`files.seal`) checks the pick against its own read of the server, seals the request to the computer it pinned and signs it
// (an OS prompt, once per request); the web posts that sealed envelope and follows the command to the computer's sealed answer, which only the shell can open (`files.open`). The server
// holds both unread. No path ever goes from here: a folder is names, and the computer decides which folder of its own a project is. «Not known» is never said as «refused»: an end the web
// cannot see is `timeout`.
//
// An open is the same road with a file's own `name` added (the shell seals a `file_read`); its answer is a text (masked lines counted) or a picture (type · size · its bytes), drawn only if it has the contract's shape.
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
  /** story 4987 (P7 · the 10-minute window): `ask` = the shell takes windows (`shell.caps.file_window`) — each request says `window: true` and the SHELL decides (it opens one only of a computer that gives windows, rides an open one without a prompt).
   *  `on` hears what the shell says of the window after each request: `{ state, ms_left }` or null (no window / it ended) */
  window?: { ask: boolean; on?: (w: WindowSeen | null) => void; /** awaited before a request is sealed: a [닫기] that is still on its way to the shell finishes first (the next request is then never made inside the window it closed) */ before?: () => Promise<void> };
}

/** what the shell says of a computer's window (never a key) */
export interface WindowSeen { state: 'opened' | 'riding'; ms_left: number }
const windowOf = (v: unknown): WindowSeen | null => (isObj(v) && (v.state === 'opened' || v.state === 'riding') && typeof v.ms_left === 'number' && Number.isFinite(v.ms_left) && v.ms_left >= 0 ? { state: v.state, ms_left: v.ms_left } : null);

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

/** [P6] the shell can OPEN a file too: `shell.caps` says `file_read: 1` (a separate word, so a web that only lists still reads `files: 1` as before) */
export async function shellTakesFileRead(phoneCall: FilesDeps['phoneCall']): Promise<boolean> {
  const caps = await phoneCall('shell.caps', {}).catch(() => null);
  return !!caps && caps.ok === true && isObj(caps.caps) && (caps.caps as { files?: unknown }).files === 1 && (caps.caps as { file_read?: unknown }).file_read === 1;
}

/** story 4987: the shell can ask for and ride the 10-minute window: `shell.caps` says `file_window: 1` (read, never guessed from a version) */
export async function shellTakesFileWindow(phoneCall: FilesDeps['phoneCall']): Promise<boolean> {
  const caps = await phoneCall('shell.caps', {}).catch(() => null);
  return !!caps && caps.ok === true && isObj(caps.caps) && (caps.caps as { files?: unknown }).files === 1 && (caps.caps as { file_window?: unknown }).file_window === 1;
}

/** the window of one computer as the shell sees it (`files.window`): opened · for how long — or null */
export async function windowState(setupId: string, phoneCall: FilesDeps['phoneCall']): Promise<WindowSeen | null> {
  const r = await phoneCall('files.window', { setup_id: setupId }).catch(() => null);
  if (!r || r.ok !== true || !isObj(r.window) || r.window.open !== true || typeof r.window.ms_left !== 'number') return null;
  return { state: 'riding', ms_left: r.window.ms_left };
}

/** [닫기]: the shell forgets the window's key at once (the computer is told nothing — its window ends by itself) */
export async function closeWindow(setupId: string, phoneCall: FilesDeps['phoneCall']): Promise<void> {
  await phoneCall('files.window_close', { setup_id: setupId }).catch(() => null);
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


/** an end that is not a body: everything but the list */
export type Ended = Exclude<FilesOutcome, { kind: 'list' }>;

/**
 * The road both requests share: the shell seals and signs (the person confirms on the OS prompt) → the web posts the envelope → the web looks for the sealed answer → the shell opens it.
 * `sealArgs(key)` is what the shell is told (the computer · the project · the NAMES · the press key); the body the shell hands back is returned as it is (the caller judges its shape).
 */
async function ask(input: { setupId: string; projectId: string; sealArgs: (key: string) => Record<string, unknown> }, deps: FilesDeps, retried = false): Promise<{ ok: true; body: unknown } | { ok: false; outcome: Ended }> {
  const key = deps.newKey();
  const stopped = deps.stopped ?? (() => false);
  const end = (outcome: Ended): { ok: false; outcome: Ended } => ({ ok: false, outcome });
  if (deps.window?.before) await deps.window.before().catch(() => {});
  if (stopped()) return end({ kind: 'cancelled' });
  const sealed = await deps.phoneCall('files.seal', { ...input.sealArgs(key), ...(deps.window?.ask ? { window: true } : {}) });
  // what the shell says of the window is the screen's only while this ask is the current one (an older ask's late word must not overwrite or erase the line of the one on screen)
  if (!sealed.ok) { if (!stopped()) deps.window?.on?.(null); return end(fromShell(sealed.code ?? '') as Ended); } // (a refused request: whatever window there was may be gone — the screen asks the shell again)
  const seen = windowOf((sealed as { window?: unknown }).window); // story 4987: what the shell says of the window this request rode or opened
  if (!stopped()) deps.window?.on?.(seen);
  if (!isObj(sealed.envelope) || typeof sealed.phone_key_id !== 'string' || sealed.idempotency_key !== key) return end({ kind: 'failed' });
  if (stopped()) return end({ kind: 'cancelled' });

  // the ask: the envelope and the ids — no name, no path
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/desktop/computers/${input.setupId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: input.projectId, idempotency_key: key, phone_key_id: sealed.phone_key_id, envelope: sealed.envelope }),
    });
  } catch {
    return end({ kind: 'timeout' }); // the ask may have reached the server: never said as «refused»
  }
  if (!res.ok) {
    if (res.status >= 500) return end({ kind: 'timeout' });
    return end(fromServer(res.status, await codeOf(res)) as Ended);
  }
  let made: { command_id?: unknown };
  try { made = (await res.json()) as typeof made; } catch { return end({ kind: 'timeout' }); }
  if (typeof made.command_id !== 'string') return end({ kind: 'timeout' });

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.pollMaxMs ?? FILES_POLL_MAX_MS);
  while (now() < deadline) {
    await wait(deps.pollMs ?? FILES_POLL_MS);
    if (stopped()) return end({ kind: 'cancelled' });
    let r: { state?: unknown; code?: unknown; envelope?: unknown };
    try {
      const got = await fetchWithAuth(`/api/desktop/computers/${input.setupId}/files/${made.command_id}`);
      if (got.status === 404) return end({ kind: 'timeout' }); // the row ended (its ten minutes · a disconnect): nothing more will come
      if (!got.ok) continue; // a look that failed is not an end (a paused one — «too fast» — is asked again)
      r = (await got.json()) as typeof r;
    } catch {
      continue;
    }
    if (isObj(r.envelope)) {
      const opened = await deps.phoneCall('files.open', { setup_id: input.setupId, project_id: input.projectId, idempotency_key: key, envelope: r.envelope });
      if (!opened.ok) return end({ kind: 'failed' });
      return { ok: true, body: opened.body };
    }
    // the computer ended without an answer: its own closed word is the end (never an answer's content)
    // story 4987: the computer refused a request that RODE a window (it forgot the window: a restart · remote control off · a pairing change) — the shell is told to forget it too and the request is made ONCE more as a first
    // request (an OS confirmation that opens a new window); a second refusal is the end
    if (r.state === 'rejected' && r.code === 'envelope_bad_signature' && seen?.state === 'riding' && !retried && !stopped()) {
      await closeWindow(input.setupId, deps.phoneCall);
      if (!stopped()) deps.window?.on?.(null);
      return ask(input, deps, true); // (a screen that left while the shell was closing the window makes no second request: the first thing `ask` does is look at `stopped`)
    }
    if (r.state === 'rejected' || r.state === 'failed') return end(r.code === 'expired' ? { kind: 'timeout' } : { kind: 'failed' });
    if (r.state === 'done') return end({ kind: 'failed' }); // done with no answer to read
  }
  return end({ kind: 'timeout' });
}

/**
 * One folder list: the shell seals and signs (the person confirms on the OS prompt) → the web posts the envelope → the web looks for the sealed answer → the shell opens it.
 * `dir` is the folder as single names (empty = the top of the project); `cursor` asks the next page of the same folder.
 */
export async function listFolder(input: { setupId: string; projectId: string; dir: string[]; cursor?: string }, deps: FilesDeps): Promise<FilesOutcome> {
  const r = await ask({
    setupId: input.setupId, projectId: input.projectId,
    sealArgs: (key) => ({ setup_id: input.setupId, project_id: input.projectId, dir: input.dir, idempotency_key: key, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) }),
  }, deps);
  return r.ok ? parseList(r.body) : r.outcome;
}

// ── [P6] opening one file ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** what a read answer may hold (the mobile repository's contract `limits.read_*`) — the shell already judged it; the web draws only what has this shape */
export const READ_LIMITS = { textBytesMax: 64 * 1024, lineCharsMax: 2000, textShownBytesMax: 128 * 1024, imageBytesMax: 150 * 1024, imagePixelsMax: 16_000_000, resultBytesMax: 220_000 } as const;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export type OpenOutcome =
  | Ended
  | { kind: 'text'; text: string; masked: number; size: number }
  | { kind: 'image'; mime: ImageMime; w: number; h: number; data: string; size: number };

// no control (but \n and \t), no invisible or direction mark, no blank look-alike: a line a screen must not draw as text
const TEXT_BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\uffa0\ufeff\ufff0-\ufffb]/u;
/** the first bytes of the data, from plain base64 (16 characters = 12 bytes): does it START like the type says? The browser decodes the rest */
function magicOk(mime: string, data: string): boolean {
  let bin = '';
  try { bin = atob(data.slice(0, 16)); } catch { return false; }
  const at = (i: number) => bin.charCodeAt(i);
  if (mime === 'image/png') return bin.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => at(i) === x);
  if (mime === 'image/jpeg') return bin.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
  if (mime === 'image/gif') return bin.length >= 6 && (bin.slice(0, 6) === 'GIF87a' || bin.slice(0, 6) === 'GIF89a');
  if (mime === 'image/webp') return bin.length >= 12 && bin.slice(0, 4) === 'RIFF' && bin.slice(8, 12) === 'WEBP';
  return false;
}
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isDim = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 2 ** 31 - 1;
const bytesOfBase64 = (t: string): number => (t.length / 4) * 3 - (t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0);
const utf8Len = (t: string): number => new TextEncoder().encode(t).length;

/** a body the computer sealed for an OPEN, checked once more here (the shell already did): a text, a picture or a refusal word — anything else is `failed` */
export function parseRead(body: unknown): OpenOutcome {
  if (!isObj(body) || body.v !== 1 || body.kind !== 'read' || typeof body.ok !== 'boolean') return { kind: 'failed' };
  const keys = Object.keys(body);
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k));
  if (body.ok === false) {
    return only(['v', 'kind', 'ok', 'reason']) && typeof body.reason === 'string' && (FILE_REASONS as readonly string[]).includes(body.reason) ? { kind: 'reason', reason: body.reason as FilesReason } : { kind: 'failed' };
  }
  if (!isCount(body.s)) return { kind: 'failed' };
  if (utf8Len(JSON.stringify(body)) > READ_LIMITS.resultBytesMax) return { kind: 'failed' };
  if (body.form === 'text') {
    if (!only(['v', 'kind', 'ok', 'form', 's', 'masked', 'text']) || !isCount(body.masked) || typeof body.text !== 'string') return { kind: 'failed' };
    if (body.s > READ_LIMITS.textBytesMax || TEXT_BAD.test(body.text) || LONE_SURROGATE.test(body.text) || utf8Len(body.text) > READ_LIMITS.textShownBytesMax) return { kind: 'failed' };
    if (body.text.split('\n').some((l) => l.length > READ_LIMITS.lineCharsMax)) return { kind: 'failed' }; // (the computer shows a longer line as the mask only)
    return { kind: 'text', text: body.text, masked: body.masked, size: body.s };
  }
  if (body.form === 'image') {
    if (!only(['v', 'kind', 'ok', 'form', 's', 'mime', 'w', 'h', 'data'])) return { kind: 'failed' };
    if (typeof body.mime !== 'string' || !(IMAGE_MIMES as readonly string[]).includes(body.mime)) return { kind: 'failed' };
    if (!isDim(body.w) || !isDim(body.h) || body.w * body.h > READ_LIMITS.imagePixelsMax) return { kind: 'failed' };
    if (typeof body.data !== 'string' || !BASE64.test(body.data) || body.s !== bytesOfBase64(body.data) || body.s < 12 || body.s > READ_LIMITS.imageBytesMax || !magicOk(body.mime, body.data)) return { kind: 'failed' };
    return { kind: 'image', mime: body.mime as ImageMime, w: body.w, h: body.h, data: body.data, size: body.s };
  }
  return { kind: 'failed' };
}

/** One file opened: the same road as a folder list with the file's own NAME added (the shell seals a `file_read`; the OS prompt names the computer, the project, the folders and the file). */
export async function openFile(input: { setupId: string; projectId: string; dir: string[]; name: string }, deps: FilesDeps): Promise<OpenOutcome> {
  const r = await ask({
    setupId: input.setupId, projectId: input.projectId,
    sealArgs: (key) => ({ setup_id: input.setupId, project_id: input.projectId, dir: input.dir, name: input.name, idempotency_key: key }),
  }, deps);
  return r.ok ? parseRead(r.body) : r.outcome;
}
