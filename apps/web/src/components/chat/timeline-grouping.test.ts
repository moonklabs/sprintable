import { describe, expect, it } from 'vitest';
import { continuesRun, RUN_GAP_MS } from './timeline-grouping';

const at = (iso: string, by = 'a') => ({ created_by: by, created_at: iso });
const T0 = '2026-11-10T01:00:00Z';
const plus = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

describe('continuesRun — one sender, no gap longer than five minutes (story 4887 · UI-4 P4-a)', () => {
  it('the first message of a day group starts a run', () => {
    expect(continuesRun(undefined, at(T0))).toBe(false);
  });

  it('⭐ the same sender within five minutes continues the run', () => {
    expect(continuesRun(at(T0), at(plus(60_000)))).toBe(true);
    expect(continuesRun(at(T0), at(plus(0)))).toBe(true); // the same second
  });

  it('⭐ exactly five minutes still continues — one millisecond more does not', () => {
    expect(RUN_GAP_MS).toBe(300_000);
    expect(continuesRun(at(T0), at(plus(RUN_GAP_MS)))).toBe(true); // reverted (`<`) → false
    expect(continuesRun(at(T0), at(plus(RUN_GAP_MS + 1)))).toBe(false); // reverted (no time rule: sender only) → true
  });

  it('⭐ a different sender never continues, however close', () => {
    expect(continuesRun(at(T0, 'a'), at(plus(1000), 'b'))).toBe(false);
  });

  it('the gap is between NEIGHBOURS, not from the start of the run (a long chat of one sender stays one run while it keeps going)', () => {
    let prev = at(T0);
    for (let i = 1; i <= 8; i++) { const next = at(plus(i * 4 * 60_000)); expect(continuesRun(prev, next)).toBe(true); prev = next; } // 32 minutes in all, 4 minutes apart
  });

  it('a message that is older than its neighbour is not a continuation (out-of-order delivery)', () => {
    expect(continuesRun(at(plus(60_000)), at(T0))).toBe(false); // reverted (abs gap) → true
  });

  it('an unreadable time starts a new run — it cannot prove «within five minutes»', () => {
    expect(continuesRun(at('not a time'), at(T0))).toBe(false);
    expect(continuesRun(at(T0), at(''))).toBe(false);
  });
  // the forms the BACKEND really sends (`isoformat()` — microseconds and an offset: «2026-11-10T07:06:37.429747+00:00»), not only the `Z` form of the other tests: a time that did not parse would make every message a new run
  it('⭐ the backend\'s own time form (six fractional digits, «+00:00») is read: 4:59.999 after is one run, a little over five minutes after is a new one', () => {
    const start = at('2026-11-10T09:00:00.123456+00:00');
    expect(continuesRun(start, at('2026-11-10T09:04:59.999999+00:00'))).toBe(true); // reverted (a parse that only reads «Z») → false
    expect(continuesRun(start, at('2026-11-10T09:05:00.200000+00:00'))).toBe(false); // 300.077 s later (the fraction is read in milliseconds: .123 → .200)
  });

  it('a time with an offset and one with «Z» are compared as the instants they are', () => {
    expect(continuesRun(at('2026-11-10T18:00:00+09:00'), at('2026-11-10T09:04:00Z'))).toBe(true); // 09:00Z and 09:04Z
    expect(continuesRun(at('2026-11-10T18:00:00+09:00'), at('2026-11-10T09:06:00Z'))).toBe(false); // 6 minutes
  });
});
