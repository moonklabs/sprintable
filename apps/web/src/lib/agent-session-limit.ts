/**
 * story #4534 (relay contract v1.12 · Yuna 03:04Z · 03:06Z) — the line under the agent's chip for the words that ask nothing of the
 * phone: asked in the terminal · an error · a usage limit. The why of a limit comes from the server row (`limit`); whether its time
 * has passed is this page's clock.
 */
export interface SessionLimit { at?: string; again?: boolean; self_resume?: 'maybe' | 'no' | 'unknown' }

export type RestLineKey = 'waitingInput' | 'error' | 'paused' | 'pausedAgain' | 'limitMaybe' | 'limitNo' | 'limitUnknown'
  | 'limitErrorNoTime' | 'limitErrorAhead' | 'limitErrorPassed';

/** the line's key (and its time, when the line names one) — null for any other state */
export function limitLine(state: string, limit: SessionLimit | null, now: number): { key: RestLineKey; at?: string } | null {
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
