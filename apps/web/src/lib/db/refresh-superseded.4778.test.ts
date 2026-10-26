// @vitest-environment jsdom
//
// story 4778 (AC2b · AC2c) — the client side of the two refresh answers that do not say «this session is over»:
//   TOKEN_SUPERSEDED  — a switch ended the token this renewal carried and issued a newer pair (another tab, or the server): ask ONCE more, after the switch's answer has had time to land
//   REFRESH_UNAVAILABLE — the backend answered 5xx · 429 · did not answer: nothing is known — no ended-session signal, the original 401 is handed back
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPERSEDED_RETRY_MS, fetchWithAuth, refreshSessionOnce, switchOrg } from './client';
import { isSessionExpiredSignaled, resetSessionExpired } from '@/lib/auth/session-expired-signal';

beforeEach(() => { resetSessionExpired(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetSessionExpired(); });

const err = (code: string, status: number) => new Response(JSON.stringify({ error: { code, message: code } }), { status });
const ok = () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });

/** a fake network: the refresh route answers from `answers` in order; everything else is a 401 for the first call then 200 */
function network(answers: Array<() => Response>) {
  const calls: Array<{ url: string; at: number }> = [];
  let refreshes = 0;
  let others = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/auth/refresh')) {
      calls.push({ url, at: Date.now() });
      return answers[Math.min(refreshes++, answers.length - 1)]!();
    }
    others += 1;
    return new Response('{}', { status: others === 1 ? 401 : 200 });
  }));
  return { calls, refreshes: () => refreshes };
}

describe('[SID:4778] a superseded renewal asks once more', () => {
  it('superseded, then ok: the second ask leaves after the pause and its answer is the result', async () => {
    vi.useFakeTimers();
    const n = network([() => err('TOKEN_SUPERSEDED', 401), ok]);
    const pending = refreshSessionOnce();
    await vi.advanceTimersByTimeAsync(SUPERSEDED_RETRY_MS - 1);
    expect(n.refreshes()).toBe(1); // not before the switch's answer has had its time
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(n.refreshes()).toBe(2); // reverted (no second ask) → 1 and the result is the superseded error
    expect(result.error).toBeNull();
  });

  it('superseded twice: it ends there — exactly two asks, the answer stays «superseded»', async () => {
    vi.useFakeTimers();
    const n = network([() => err('TOKEN_SUPERSEDED', 401)]);
    const pending = refreshSessionOnce();
    await vi.advanceTimersByTimeAsync(SUPERSEDED_RETRY_MS * 5);
    const result = await pending;
    expect(n.refreshes()).toBe(2); // a third ask would be a loop
    expect(result.error?.code).toBe('TOKEN_SUPERSEDED');
  });

  it('any other failure is not asked again (a revoked token stays revoked)', async () => {
    const n = network([() => err('TOKEN_REVOKED', 401)]);
    const result = await refreshSessionOnce();
    expect(n.refreshes()).toBe(1);
    expect(result.error?.code).toBe('TOKEN_REVOKED');
  });
});

describe('[SID:4778] fetchWithAuth: an unconfirmed or superseded renewal does not end the session', () => {
  it('a 401 whose renewal is superseded twice → the original 401 is handed back and NO ended-session signal', async () => {
    vi.useFakeTimers();
    network([() => err('TOKEN_SUPERSEDED', 401)]);
    const pending = fetchWithAuth('/api/something');
    await vi.advanceTimersByTimeAsync(SUPERSEDED_RETRY_MS * 5);
    const res = await pending;
    expect(res.status).toBe(401);
    expect(isSessionExpiredSignaled()).toBe(false); // reverted (any renewal error signals) → true
  });

  it('a 401 whose renewal «could not be confirmed» (REFRESH_UNAVAILABLE) → no signal, no second ask of the renewal', async () => {
    const n = network([() => err('REFRESH_UNAVAILABLE', 503)]);
    const res = await fetchWithAuth('/api/something');
    expect(res.status).toBe(401);
    expect(n.refreshes()).toBe(1);
    expect(isSessionExpiredSignaled()).toBe(false);
  });

  it('a renewal the server says is dead (TOKEN_REVOKED) still ends the session: the signal is sent', async () => {
    network([() => err('TOKEN_REVOKED', 401)]);
    await fetchWithAuth('/api/something');
    expect(isSessionExpiredSignaled()).toBe(true);
  });
});

describe('[SID:4778] a switch with withAuth: the same rule for its renewal', () => {
  it('the switch answers 401 and its renewal «could not be confirmed» → the 401 is handed back, NO ended-session signal, the next switch still leaves', async () => {
    let switches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/refresh')) return err('REFRESH_UNAVAILABLE', 503);
      switches += 1;
      return new Response('{}', { status: 401 });
    }));
    const first = await switchOrg('org-1', { withAuth: true });
    expect(first.status).toBe(401);
    expect(isSessionExpiredSignaled()).toBe(false); // reverted (any renewal error signals) → true and the next switch is refused before it leaves
    const second = await switchOrg('org-2', { withAuth: true });
    expect(second.status).toBe(401);
    expect(switches).toBe(2);
  });

  it('a renewal the server says is dead still ends the session for a switch (the signal is sent)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).includes('/api/auth/refresh') ? err('TOKEN_REVOKED', 401) : new Response('{}', { status: 401 }))));
    await switchOrg('org-1', { withAuth: true });
    expect(isSessionExpiredSignaled()).toBe(true);
  });
});
