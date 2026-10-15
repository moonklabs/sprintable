/**
 * story #4534 (relay contract v1.12 · Yuna 03:04Z · 03:06Z) — the line under the agent's chip for the words that ask nothing of the
 * phone: asked in the terminal · an error · a usage limit. The why of a limit comes from the server row (`limit`); whether its time
 * has passed is this page's clock.
 */
// story #4560 (contract v2.1 §5): `held` — the limit's time came, but the terminal was not what the app expected, so it pressed nothing
// story #4685 (relay contract, additive · PO 10-14 00:39Z · Yuna `limit-notice-1014.md` §③): `looks` — the daemon that reported this limit
// looks at it again by itself (its reset time is unknown). Absent from a daemon from before: it never does, so nothing here may say it does.
export interface SessionLimit { at?: string; again?: boolean; self_resume?: 'maybe' | 'no' | 'unknown'; held?: 'screen' | 'esc_not_taken'; looks?: true }

export type RestLineKey = 'waitingInput' | 'error' | 'paused' | 'pausedAgain' | 'limitMaybe' | 'limitNo' | 'limitUnknown' | 'limitLooking'
  | 'limitErrorNoTime' | 'limitErrorAhead' | 'limitErrorPassed' | 'limitHeld';

const LIMIT_STATES = new Set(['waiting_input', 'error', 'paused_limit']);

/** story #4560 (Yuna `4560-limit-resume-copy.md` §③): a held limit wears the board's «사용 한도» look and its own line, no button —
 *  on a limit word only (the server never sends a limit on another) */
export function limitHeld(state: string, limit: SessionLimit | null | undefined): boolean {
  return LIMIT_STATES.has(state) && (limit?.held === 'screen' || limit?.held === 'esc_not_taken');
}

/** story #4685 (Yuna §③ — the next step decides the word): a limit the APP will look at again (`looks`, which only a daemon that does
 *  says) is «한도로 쉬는 중» — nothing for a person to do; a held one (a person must look at that computer) and one from a daemon that
 *  does not look stay «사용 한도» (fail-closed: «the app checks again» is never promised by a daemon that never does — 10-13: 7 hours).
 *  The server's turn-end notice (`desktop_commands._turn_end_kind`) reads the same table. */
export function limitLooksAgain(state: string, limit: SessionLimit | null | undefined): boolean {
  return state === 'waiting_input' && !!limit?.self_resume && limit.looks === true && !limitHeld(state, limit);
}

/** the line's key (and its time, when the line names one) — null for any other state */
export function limitLine(state: string, limit: SessionLimit | null, now: number): { key: RestLineKey; at?: string } | null {
  if (limitHeld(state, limit)) return { key: 'limitHeld' }; // the person's next step is at that terminal, whatever the time says
  if (limitLooksAgain(state, limit)) return { key: 'limitLooking' }; // story #4685: the three self_resume lines would be untrue here
  if (state === 'paused_limit') {
    return limit?.at ? { key: limit.again ? 'pausedAgain' : 'paused', at: limit.at } : { key: 'limitErrorNoTime' };
  }
  if (state === 'waiting_input') {
    const r = limit?.self_resume;
    if (r === 'maybe') return { key: 'limitMaybe' };
    if (r === 'no') return { key: 'limitNo' };
    if (r === 'unknown') return { key: 'limitUnknown' };
    return { key: 'waitingInput' };
  }
  if (state === 'error') {
    if (!limit) return { key: 'error' };
    if (!limit.at) return { key: 'limitErrorNoTime' };
    return Date.parse(limit.at) > now ? { key: 'limitErrorAhead', at: limit.at } : { key: 'limitErrorPassed' };
  }
  return null;
}

/** «오후 3:20» today · «10월 6일 오후 3:20» otherwise (en «at 3:20 PM» · «Oct 6, 3:20 PM») — the board's resetTime, in this page's zone */
export function limitTime(iso: string, now: number, locale: string, timeZone?: string): string {
  const d = new Date(iso);
  const sameDay = (a: Date, b: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(a)
    === new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(b);
  const ko = locale.startsWith('ko');
  const time = new Intl.DateTimeFormat(ko ? 'ko-KR' : 'en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  if (sameDay(d, new Date(now))) return ko ? time : `at ${time}`;
  const day = new Intl.DateTimeFormat(ko ? 'ko-KR' : 'en-US', { timeZone, month: ko ? 'long' : 'short', day: 'numeric' }).format(d);
  return `${day}${ko ? ' ' : ', '}${time}`;
}
