// story #4714 (contract 02d2cf71 §14 v1.17 · v1.18 · spec yuna/4714-copy-1017.md): from inside the phone app, start an agent that already
// exists on a paired computer — in the folder that computer holds for the picked project.
//
// The web only says which computer · agent · project (three ids it read from the server). The phone app's shell reads the same list
// from the server itself, checks the pick is in it, asks the person on the OS prompt and signs exactly seven keys
// (`{v, kind:'start_session', setup_id, agent_member_id, project_id, expires_at, nonce}`); the web then posts the shell's `signed` and
// follows the command to its end. No path · folder · mode · arguments · runtime ever goes from here: the computer decides the folder
// from its own files. «Not known» is never said as «not started» (the same rule as phone-command.ts): once the post may have reached
// the server, an end the web cannot see is `unknown` — [결과 확인] follows THAT command (same key · same signed body · no new signature).

import { fetchWithAuth } from '@/lib/db/client';
import type { PhoneAnswer } from './phone-bridge';

export interface StartableProject { project_id: string; name: string }
/** `running` (story 4714): true a session lives · false none / all over · null the computer has not been heard from — or a server that does not say (never read as «not running») */
export interface StartableAgent { agent_member_id: string; name: string; can_command: boolean; projects: StartableProject[]; running: boolean | null }
export interface StartableComputer { setup_id: string; device_name: string; reachable: boolean; agents: StartableAgent[] }
export interface StartableView { remote_control: boolean; computers: StartableComputer[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** the server's list, kept only as far as it has the shape the screen draws (a field that is not ours is dropped · a row without its ids is dropped) */
export function parseStartable(raw: unknown): StartableView | null {
  if (!isObj(raw) || typeof raw.remote_control !== 'boolean' || !Array.isArray(raw.computers)) return null;
  const computers: StartableComputer[] = [];
  for (const c of raw.computers) {
    if (!isObj(c) || !isStr(c.setup_id) || !isStr(c.device_name) || !Array.isArray(c.agents)) continue;
    const agents: StartableAgent[] = [];
    for (const a of c.agents) {
      if (!isObj(a) || !isStr(a.agent_member_id) || !isStr(a.name) || !Array.isArray(a.projects)) continue;
      const projects = a.projects.filter((p): p is Record<string, unknown> => isObj(p) && isStr(p.project_id) && isStr(p.name)).map((p) => ({ project_id: p.project_id as string, name: p.name as string }));
      agents.push({ agent_member_id: a.agent_member_id, name: a.name, can_command: a.can_command === true, projects, running: typeof a.running === 'boolean' ? a.running : null });
    }
    computers.push({ setup_id: c.setup_id, device_name: c.device_name, reachable: c.reachable === true, agents });
  }
  return { remote_control: raw.remote_control, computers };
}

type Call = (type: string, args: Record<string, unknown>) => Promise<PhoneAnswer>;

export type StartableRead =
  | { kind: 'view'; view: StartableView }
  | { kind: 'no_phone' } // this phone has no key registered on the server — it is paired with nothing
  | { kind: 'no_screen_lock' }
  | { kind: 'failed' };

/**
 * Which computers is THIS phone paired with — and what can be started on them. The phone's key is found the way the server shows it:
 * the shell's `key_number` is the «phone check number» the server's own list prints (`confirm_number`), so a read-only match on the list;
 * nothing is registered from here.
 */
export async function readStartable(phoneCall: Call, stop?: () => boolean): Promise<StartableRead> {
  let key: PhoneAnswer;
  try { key = await phoneCall('device.key.info', {}); } catch { return { kind: 'failed' }; } // a bridge call that is rejected is a failed read, not a screen stuck on «reading»
  if (stop?.()) return { kind: 'failed' }; // `stop`: the caller gave up on this read (its limit · its screen) — no further request is made for it
  if (!key.ok) return key.code === 'no_screen_lock' ? { kind: 'no_screen_lock' } : { kind: 'failed' };
  if (typeof key.key_number !== 'string') return { kind: 'failed' };
  let id: string | null = null;
  try {
    const res = await fetchWithAuth('/api/remote-devices');
    if (!res.ok) return { kind: 'failed' };
    const body = (await res.json()) as { devices?: Array<{ id?: unknown; confirm_number?: unknown }> };
    if (!Array.isArray(body.devices)) return { kind: 'failed' };
    const mine = body.devices.find((d) => d && d.confirm_number === key.key_number && typeof d.id === 'string');
    id = mine ? (mine.id as string) : null;
  } catch {
    return { kind: 'failed' };
  }
  if (id === null) return { kind: 'no_phone' };
  if (stop?.()) return { kind: 'failed' };
  try {
    const res = await fetchWithAuth(`/api/desktop/startable?phone_key_id=${encodeURIComponent(id)}`);
    if (!res.ok) return { kind: 'failed' };
    const view = parseStartable(await res.json());
    return view ? { kind: 'view', view } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

export type StartOutcome =
  | { kind: 'started' } // the computer started the session
  | { kind: 'already_running' } // the agent already has a session there — continue in its chat
  | { kind: 'no_folder' } // that project has no folder on that computer (or it changed) — pick one at the computer
  | { kind: 'unreachable' } // 409 device_unreachable — certainly not started
  | { kind: 'remote_off' }
  | { kind: 'not_paired' } // 409 phone_not_paired · the shell found no such computer on this phone's list
  | { kind: 'cancelled' } // the person said no on the OS prompt — not a failure, no line
  | { kind: 'biometric_required' }
  | { kind: 'no_screen_lock' }
  | { kind: 'key_invalidated' }
  | { kind: 'not_registered' }
  | { kind: 'signed_out' }
  | { kind: 'unknown'; pending: Pending } // it may have gone (the answer was lost · no end in two minutes) — follow it, never redo it
  | { kind: 'failed' };

export interface StartInput { setupId: string; agentId: string; projectId: string }
/** a start the web posted (or tried to): what [결과 확인] follows again — the same key and body, its id once known */
export interface Pending { agentId: string; key: string; body: Record<string, unknown>; commandId?: string }

export interface StartDeps {
  phoneCall: Call;
  /** a fresh idempotency key per press (the server keys the start on it) */
  newKey: () => string;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  pollMaxMs?: number;
}

/** contract §11: the web follows the command every 1.5 s, two minutes at most */
export const START_POLL_MS = 1_500;
export const START_POLL_MAX_MS = 120_000;

// the shell's refusals → one outcome each (the codes are the shell's own: phoneCalls.js startSign · the bridge's key refusals)
const SHELL_REFUSALS: Record<string, StartOutcome['kind']> = {
  cancelled: 'cancelled',
  biometric_required: 'biometric_required',
  no_screen_lock: 'no_screen_lock',
  key_invalidated: 'key_invalidated',
  not_registered: 'not_registered',
  signed_out: 'signed_out',
  remote_control_off: 'remote_off',
  computer_not_found: 'not_paired',
  device_unreachable: 'unreachable',
  no_folder: 'no_folder',
};

async function codeOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: string }; code?: string };
    return body.error?.code ?? body.code ?? '';
  } catch {
    return '';
  }
}

export async function startOnPhone(input: StartInput, deps: StartDeps): Promise<StartOutcome> {
  let signed: PhoneAnswer;
  try {
    signed = await deps.phoneCall('command.sign', { kind: 'start_session', setup_id: input.setupId, agent_member_id: input.agentId, project_id: input.projectId });
  } catch {
    return { kind: 'failed' }; // the bridge rejected the call: nothing was signed, nothing was posted — never a start left «busy»
  }
  if (!signed.ok) return { kind: SHELL_REFUSALS[signed.code ?? ''] ?? 'failed' } as StartOutcome;
  if (typeof signed.signed !== 'string' || typeof signed.phone_key_id !== 'string') return { kind: 'failed' };
  const pending: Pending = {
    agentId: input.agentId,
    key: deps.newKey(),
    // closed: the three ids the person picked + the shell's two values — never a path · mode · arguments · runtime
    body: { setup_id: input.setupId, project_id: input.projectId, signed: signed.signed, phone_key_id: signed.phone_key_id },
  };
  return post(pending, deps);
}

/** [결과 확인]: the same start again — its id when known (follow it), else the same post (same key: the server gives back the command it made, if any) */
export async function checkStart(pending: Pending, deps: StartDeps): Promise<StartOutcome> {
  return pending.commandId ? follow(pending, deps) : post(pending, deps);
}

async function post(pending: Pending, deps: StartDeps): Promise<StartOutcome> {
  let res: Response;
  try {
    res = await fetchWithAuth(`/api/agents/${pending.agentId}/desktop-start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...pending.body, idempotency_key: pending.key }),
    });
  } catch {
    return { kind: 'unknown', pending }; // the post may have reached the server — its answer was lost
  }
  if (!res.ok) {
    if (res.status >= 500) return { kind: 'unknown', pending }; // any 5xx may have come after the command was made — followed, never redone
    const code = await codeOf(res);
    if (code === 'device_unreachable') return { kind: 'unreachable' };
    if (code === 'remote_control_off') return { kind: 'remote_off' };
    if (code === 'phone_not_paired') return { kind: 'not_paired' };
    if (code === 'no_folder') return { kind: 'no_folder' };
    return { kind: 'failed' }; // another 4xx: refused before anything was made
  }
  let made: { command_id?: string };
  try { made = (await res.json()) as typeof made; } catch { return { kind: 'unknown', pending }; }
  // a valid JSON body that is not an object (null · a number) is no command id — kept as unknown, never dereferenced
  if (!made || typeof made !== 'object' || typeof made.command_id !== 'string') return { kind: 'unknown', pending };
  return follow({ ...pending, commandId: made.command_id }, deps);
}

// follow it: done · the daemon's closed reasons · any other end · two minutes on the wall clock without an end
async function follow(pending: Pending, deps: StartDeps): Promise<StartOutcome> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const every = deps.pollMs ?? START_POLL_MS;
  const deadline = now() + (deps.pollMaxMs ?? START_POLL_MAX_MS);
  while (now() < deadline) {
    await wait(every);
    let r: { state?: string; result_code?: string | null };
    try {
      const got = await fetchWithAuth(`/api/agents/${pending.agentId}/desktop-commands/${pending.commandId}`);
      if (!got.ok) continue; // a read that failed is not an end — ask again
      r = (await got.json()) as typeof r;
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object') continue; // a body that is not an object is not an end — ask again
    if (r.state === 'done') return { kind: 'started' };
    if (r.state === 'rejected' || r.state === 'failed') {
      if (r.result_code === 'remote_control_off') return { kind: 'remote_off' }; // switched off while the command was on its way — the screen goes back to branch 1
      if (r.state === 'rejected' && r.result_code === 'already_running') return { kind: 'already_running' };
      if (r.state === 'rejected' && r.result_code === 'no_folder') return { kind: 'no_folder' };
      if (r.state === 'failed' && r.result_code === 'workdir_refused') return { kind: 'no_folder' }; // the mapping changed before the spawn
      return { kind: 'failed' };
    }
  }
  return { kind: 'unknown', pending };
}

/** after a start is done on the Mac the session still has to STAND (the server reads it as running): look every 2 s, half a minute at most */
export const STAND_POLL_MS = 2_000;
export const STAND_POLL_MAX_MS = 30_000;

/**
 * «started» is the Mac's word that it spawned the session — not that the agent is up (started ≠ stood). The start screen waits for the SERVER to say the agent
 * runs on that computer (the same `running` word the landing reads) before it opens the conversation. `stood`: it runs · `waiting`: not within the limit ·
 * `gone`: the screen left meanwhile (nothing is moved).
 */
export async function waitForSession(
  target: { setupId: string; agentId: string },
  deps: Pick<StartDeps, 'phoneCall' | 'wait' | 'now' | 'pollMs' | 'pollMaxMs'> & { alive?: () => boolean },
): Promise<'stood' | 'waiting' | 'gone'> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const every = deps.pollMs ?? STAND_POLL_MS;
  const deadline = now() + (deps.pollMaxMs ?? STAND_POLL_MAX_MS);
  const alive = deps.alive ?? (() => true);
  for (;;) {
    if (!alive()) return 'gone';
    // the read is bounded by what is left of the limit: a bridge call can wait minutes (phone-bridge.ts) — the 30 s are 30 s, and a read that comes after them is dropped
    const left = Math.max(deadline - now(), 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false; // this read is given up (its limit passed · the screen left): readStartable makes no further request for it
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => { over = true; resolve('late'); }, left); });
    const read = await Promise.race([readStartable(deps.phoneCall, () => over || !alive()), late]); // readStartable never rejects: a read that failed is `failed` — not an answer, ask again
    clearTimeout(timer);
    if (read === 'late') return alive() ? 'waiting' : 'gone';
    if (!alive()) return 'gone';
    if (now() > deadline) return 'waiting'; // an answer that came AFTER the limit is not «within the limit» (a late timer does not buy extra time)
    if (read && read.kind === 'view') {
      const agent = read.view.computers.find((c) => c.setup_id === target.setupId)?.agents.find((a) => a.agent_member_id === target.agentId);
      if (agent?.running === true) return 'stood';
    }
    const remaining = deadline - now();
    if (remaining <= 0) return 'waiting';
    await wait(Math.min(every, remaining)); // the sleep is cut by what is left too: the last look is AT the limit, never after it
  }
}

/**
 * The person pressed a way OUT of this screen (the start screen's «대시보드로» · the onboarding's «오늘로 가기»): whatever is still waited for here must not move the page
 * afterwards (the onboarding's finish waits for an auth refresh — a second move would land on top of it). While it is set the screen starts nothing new and reads nothing more (a page on its way out does not begin a second flow).
 */
let leaving = false;
export const markLeaving = (): void => { leaving = true; };
export const clearLeaving = (): void => { leaving = false; };
export const isLeaving = (): boolean => leaving;
