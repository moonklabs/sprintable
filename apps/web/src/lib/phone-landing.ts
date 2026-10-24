// story 4714 (AC3 · AC4 — PO 10-19: «갈림은 조직 유무가 아니라 폰 앱이 열릴 때의 짝지은 맥 · 도는 에이전트로 · 서버가 아는 값으로 한 곳에서»).
//
// Where the phone app lands when it is opened. The shell always opens `/glance`; the proxy sends that shell-started load (and only that one) to
// `/phone-landing?next=<the home it resolved>` for a person who has an organization, and this decides from what the SERVER says in the one read the start
// screen already makes — which computers THIS phone is paired with and, for each agent the person may open, whether it runs (`running`):
//   · an agent runs on a paired computer → the chat list (AC4: nothing to start — the running agent's chat is where the person goes);
//   · paired, and nothing runs → the start screen («○○ 맥에서 에이전트를 시작할까요?», AC3);
//   · not paired with any computer → the usual home (a person with no organization was already sent to the onboarding by the proxy).
// Anything not known — a read that fails · an agent on a heard-from computer the server cannot tell about (`running: null`) · a server that does not say — is
// the usual home: never a dead end made of a missing answer. A computer that has not been heard from at all is left out of the decision (not paired with any
// computer that is up → the usual home).
//
// Once per app launch: the landing is the app OPENING, not every time the shell asks for the home address (a back press that is absorbed into the home goes
// there again). The mark lives in sessionStorage — the web view's own storage, gone with the launch. A storage that cannot be read or written cannot keep
// the promise «once», so it lands nowhere: the usual home, every time.
import { readStartable } from '@/lib/phone-start';
import { fetchWithAuth } from '@/lib/db/client';

export type Landing = 'home' | 'chats' | 'start';

type PhoneCall = Parameters<typeof readStartable>[0];

/**
 * story #4762 (AC7) — is this person still in the onboarding? The server's own checklist: no agent connected yet (`steps.agent_connected === false`). Anything else —
 * connected, a read that failed, an answer of another shape — is «no» (never a screen forced on someone because a read went wrong).
 */
async function onboardingOpen(): Promise<boolean> {
  try {
    const res = await fetchWithAuth('/api/activation/checklist');
    if (!res.ok) return false;
    const json = (await res.json()) as { data?: { steps?: { agent_connected?: unknown } } };
    return json.data?.steps?.agent_connected === false;
  } catch {
    return false;
  }
}

/**
 * where this phone goes now — every failure answers `home`.
 * story #4762 (AC7): a phone with NO computer to start anything on (paired with nothing · no computer heard from) that belongs to a person still in the onboarding
 * (no agent connected yet) lands on the start screen too — the one that says «agents run on your Mac» — not on Today. 4758 measured it: the person switched the app
 * off and on in the middle of the onboarding and fell through to Today, without the next step in sight.
 */
export async function decideLanding(phoneCall: PhoneCall): Promise<Landing> {
  const read = await readStartable(phoneCall).catch(() => null);
  if (!read || read.kind === 'failed') return 'home'; // a read that failed: not «paired with nothing»
  // paired with nothing (no key on the server · no screen lock): the start screen while the onboarding is open, else the usual home
  if (read.kind !== 'view') return (await onboardingOpen()) ? 'start' : 'home';
  // only a computer that was heard from counts: a silent one (an old Mac the person stopped using) can start nothing and says `running: null` about everything —
  // letting it in would keep a person with a working Mac at the usual home for good
  const heard = read.view.computers.filter((c) => c.reachable);
  if (heard.length === 0) return (await onboardingOpen()) ? 'start' : 'home';
  const agents = heard.flatMap((c) => c.agents);
  if (agents.some((a) => a.running === true)) return 'chats'; // any agent on any paired computer that runs: that is the running agent
  if (agents.some((a) => a.running === null)) return 'home'; // one we could not tell about: not «nothing is running»
  return 'start';
}

const MARK = 'sprintable.phoneLanding';

/** true once this launch has had its landing (a storage that cannot be read counts as «had it» — the usual home, never a loop) */
export function landedThisLaunch(): boolean {
  try { return window.sessionStorage.getItem(MARK) === '1'; } catch { return true; }
}

/** make the mark; false when it cannot be made (a storage that refuses writes) — then «once per launch» cannot be kept and the caller goes home */
export function markLanded(): boolean {
  try {
    window.sessionStorage.setItem(MARK, '1');
    return window.sessionStorage.getItem(MARK) === '1';
  } catch {
    return false;
  }
}
