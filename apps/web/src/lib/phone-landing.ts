// story 4714 (AC3 · AC4 — PO 10-19: «갈림은 조직 유무가 아니라 폰 앱이 열릴 때의 짝지은 맥 · 도는 에이전트로 · 서버가 아는 값으로 한 곳에서»).
//
// Where the phone app lands when it is opened. The shell always opens `/glance`; the proxy sends that shell-started load (and only that one) to
// `/phone-landing` for a person who has an organization, and this decides from two things the SERVER knows — which computers THIS phone is paired
// with (`/api/remote-devices` · `/api/desktop/startable`, the same read the start screen makes) and whether any of their agents has a live session
// (`GET /api/desktop/setups/{id}/sessions`):
//   · a paired computer has a live session → the chat list (AC4: nothing to start — the running agent's chat is where the person goes);
//   · paired, and none of the sessions lives → the start screen («○○ 맥에서 에이전트를 시작할까요?», AC3);
//   · not paired with any computer → the usual home (a person with no organization was already sent to the onboarding by the proxy).
// Anything not known — a read that fails · a device that is silent (its sessions read `unknown`) · a body of another shape — is the usual home:
// never a dead end made of a missing answer.
//
// Once per app launch: the landing is the app OPENING, not every time the shell asks for the home address (a back press that is absorbed into the
// home goes there again). The mark lives in sessionStorage — the web view's own storage, gone with the launch.
import { fetchWithAuth } from '@/lib/db/client';
import { readStartable } from '@/lib/phone-start';

export type Landing = 'home' | 'chats' | 'start';

type PhoneCall = Parameters<typeof readStartable>[0];

/** a session in the server's list: `stopped` is over · `unknown` is a device that has not been heard from (never «dead») · every other word is a session that lives */
const OVER = 'stopped';
const SILENT = 'unknown';

type SessionsRead = { kind: 'live' } | { kind: 'none' } | { kind: 'unknown' };

async function readSessions(setupId: string): Promise<SessionsRead> {
  try {
    const res = await fetchWithAuth(`/api/desktop/setups/${encodeURIComponent(setupId)}/sessions`);
    if (!res.ok) return { kind: 'unknown' };
    const body = (await res.json()) as { sessions?: unknown };
    if (!Array.isArray(body.sessions)) return { kind: 'unknown' };
    let silent = false;
    for (const s of body.sessions) {
      const state = s && typeof s === 'object' ? (s as { state?: unknown }).state : undefined;
      if (typeof state !== 'string') return { kind: 'unknown' }; // a row that does not say its state is a list we cannot read
      if (state === SILENT) silent = true;
      else if (state !== OVER) return { kind: 'live' };
    }
    return silent ? { kind: 'unknown' } : { kind: 'none' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** where this phone goes now — every failure answers `home` */
export async function decideLanding(phoneCall: PhoneCall): Promise<Landing> {
  const read = await readStartable(phoneCall).catch(() => null);
  if (!read || read.kind !== 'view') return 'home'; // no key on the server (paired with nothing) · no screen lock · a read that failed
  const computers = read.view.computers;
  if (computers.length === 0) return 'home';
  const reads = await Promise.all(computers.map((c) => readSessions(c.setup_id)));
  if (reads.some((r) => r.kind === 'live')) return 'chats'; // any computer with a live session: that is the running agent
  if (reads.some((r) => r.kind === 'unknown')) return 'home'; // a computer we could not tell about: not «nothing is running»
  return 'start';
}

const MARK = 'sprintable.phoneLanding';

/** true once this launch has had its landing (a storage that cannot be read counts as «had it» — the usual home, never a loop) */
export function landedThisLaunch(): boolean {
  try { return window.sessionStorage.getItem(MARK) === '1'; } catch { return true; }
}

export function markLanded(): void {
  try { window.sessionStorage.setItem(MARK, '1'); } catch { /* the next read says «had it» */ }
}
