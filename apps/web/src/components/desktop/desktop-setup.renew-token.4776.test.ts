// @vitest-environment jsdom
// story 4776 (codex round 3) — `renewToken` (desktop-setup.tsx: the renewal after the organization has changed, run by `joinNewOrg`) used to POST the refresh route itself through fetchWithAuth, outside the
// page's one flight: another request's 401 renewal and this one rotated the SAME cookie at once (a loser lives only by the server's 180 s window; with none it is a 401 and the route clears both cookies).
// It now goes through `refreshSessionAfterChange`: one rotation at a time, joined by whatever else is renewing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renewToken } from './desktop-setup';
import { refreshSessionOnce } from '@/lib/db/client';

afterEach(() => { vi.unstubAllGlobals(); });

function scripted(statuses: number[]) {
  let calls = 0;
  const gates: Array<() => void> = [];
  let hold = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (!String(input).includes('/api/auth/refresh')) return new Response('{}', { status: 200 });
    const status = statuses[Math.min(calls, statuses.length - 1)]!;
    calls += 1;
    if (hold && calls === 1) await new Promise<void>((resolve) => { gates.push(resolve); });
    return new Response(JSON.stringify(status === 200 ? { data: { ok: true } } : { error: { code: 'X', message: 'no' } }), { status });
  }));
  return { calls: () => calls, gates, hold: () => { hold = true; } };
}

describe('[SID:4776] renewToken goes through the page\'s one flight', () => {
  it('a rotation another path has open (an interceptor\'s 401 renewal) is waited for, then ONE more is made — never two at once, never a direct POST beside it', async () => {
    const s = scripted([200]);
    s.hold();
    const early = refreshSessionOnce(); // already in flight on the same cookie
    await vi.waitFor(() => expect(s.calls()).toBe(1));
    const renewed = renewToken();
    await Promise.resolve(); await Promise.resolve();
    expect(s.calls()).toBe(1); // reverted (a direct POST of the route) → 2 at once
    s.gates[0]!();
    await early;
    expect(await renewed).toBe(true);
    expect(s.calls()).toBe(2); // the renewal after the change made its own, after the early one ended
  });

  it('an answer that is not ok (401 · 5xx) is a failure and is tried once more — the same as before (4429 ①)', async () => {
    const s = scripted([503, 200]);
    expect(await renewToken()).toBe(true);
    expect(s.calls()).toBe(2); // 503 → retry ok
    const t = scripted([401, 503]);
    expect(await renewToken()).toBe(false);
    expect(t.calls()).toBe(2); // refused twice → false (and still just one try more)
  });

  it('a network failure is a failure too (no throw), tried once more', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { n += 1; throw new Error('network'); }));
    expect(await renewToken()).toBe(false);
    expect(n).toBe(2);
  });
});
