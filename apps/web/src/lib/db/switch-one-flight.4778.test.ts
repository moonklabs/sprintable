// @vitest-environment jsdom
//
// story 4778 — the org / project switch joins the page's one flight with the refresh rotation. A switch revokes the session's refresh token on the server and answers with a new pair; a rotation that
// left with the OLD token while it was in flight is refused (401 → the refresh route clears BOTH cookies = logout while switching: backend/tests/test_4778_switch_vs_refresh_realdb.py).
// So the two never overlap: a switch waits for a rotation already in flight and for earlier switches, a renewal asked for while a switch is open waits for its answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSessionOnce, switchOrg, switchProject } from './client';
import { isSessionExpiredSignaled, resetSessionExpired } from '@/lib/auth/session-expired-signal';

beforeEach(() => { resetSessionExpired(); });
afterEach(() => { vi.unstubAllGlobals(); resetSessionExpired(); });

interface Call { kind: 'refresh' | 'switch-org' | 'switch-project'; n: number; start: number; end?: number; body?: unknown }

/** a fake network: every refresh / switch call is logged with a logical clock; `hold(kind, nth)` keeps that call's answer back until its gate is opened */
function scripted(opts: { switchStatuses?: number[]; refreshStatuses?: number[] } = {}) {
  const calls: Call[] = [];
  let clock = 0;
  let active = 0;
  let maxActive = 0;
  const holds = new Map<string, () => void>();
  const wanted = new Set<string>();
  let switches = 0;
  let refreshes = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const kind = url.includes('/api/auth/refresh') ? 'refresh' : url.includes('/api/switch-org') ? 'switch-org' : url.includes('/api/switch-project') ? 'switch-project' : null;
    if (!kind) return new Response('{}', { status: 200 });
    const nth = kind === 'refresh' ? ++refreshes : ++switches;
    const call: Call = { kind, n: calls.length + 1, start: ++clock, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const key = `${kind === 'refresh' ? 'refresh' : 'switch'}#${nth}`;
    if (wanted.has(key)) await new Promise<void>((resolve) => { holds.set(key, resolve); });
    active -= 1;
    call.end = ++clock;
    const status = kind === 'refresh' ? (opts.refreshStatuses?.[nth - 1] ?? 200) : (opts.switchStatuses?.[nth - 1] ?? 200);
    return new Response(JSON.stringify(status === 200 ? { data: { ok: true } } : { error: { code: 'X', message: 'no' } }), { status });
  }));
  return {
    calls,
    maxActive: () => maxActive,
    hold: (key: string) => { wanted.add(key); },
    release: (key: string) => { holds.get(key)?.(); },
    isOut: (key: string) => holds.has(key),
  };
}
const tick = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

describe('[SID:4778] switch × rotation: one at a time, in the order they were asked for', () => {
  it('a switch alone makes one POST to its route with its body', async () => {
    const s = scripted();
    expect((await switchOrg('org-1')).ok).toBe(true);
    expect((await switchProject('proj-1')).ok).toBe(true);
    expect(s.calls.map((c) => [c.kind, c.body])).toEqual([['switch-org', { org_id: 'org-1' }], ['switch-project', { project_id: 'proj-1' }]]);
  });

  it('a rotation already in flight finishes BEFORE the switch leaves (the switch must present the cookie that rotation sets)', async () => {
    const s = scripted();
    s.hold('refresh#1');
    const rotation = refreshSessionOnce();
    await vi.waitFor(() => expect(s.isOut('refresh#1')).toBe(true));
    const sw = switchOrg('org-1');
    await tick();
    expect(s.calls.map((c) => c.kind)).toEqual(['refresh']); // reverted (switch is a plain fetch) → the switch is already out
    s.release('refresh#1');
    await Promise.all([rotation, sw]);
    expect(s.calls.map((c) => c.kind)).toEqual(['refresh', 'switch-org']);
    expect(s.calls[1]!.start).toBeGreaterThan(s.calls[0]!.end!);
    expect(s.maxActive()).toBe(1);
  });

  it('a renewal asked for while a switch is open waits for the switch\'s answer (its Set-Cookie is in the jar) — it never leaves with the token the switch revoked', async () => {
    const s = scripted();
    s.hold('switch#1');
    const sw = switchOrg('org-1');
    await vi.waitFor(() => expect(s.isOut('switch#1')).toBe(true));
    const renewal = refreshSessionOnce();
    await tick();
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org']); // reverted (rotation does not look at the switch) → the refresh is out beside it
    s.release('switch#1');
    await Promise.all([sw, renewal]);
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org', 'refresh']);
    expect(s.calls[1]!.start).toBeGreaterThan(s.calls[0]!.end!);
    expect(s.maxActive()).toBe(1);
  });

  it('two switches are serial: the second leaves only after the first answered', async () => {
    const s = scripted();
    s.hold('switch#1');
    const a = switchOrg('org-1');
    await vi.waitFor(() => expect(s.isOut('switch#1')).toBe(true));
    const b = switchProject('proj-1');
    await tick();
    expect(s.calls).toHaveLength(1);
    s.release('switch#1');
    await Promise.all([a, b]);
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org', 'switch-project']);
    expect(s.maxActive()).toBe(1);
  });

  it('asked-for order holds: switch (open) → switch → renewal → switch run as switch, switch, refresh, switch — and nothing deadlocks', async () => {
    const s = scripted();
    s.hold('switch#1');
    const s1 = switchOrg('org-1');
    await vi.waitFor(() => expect(s.isOut('switch#1')).toBe(true));
    const s2 = switchProject('proj-1');
    const r = refreshSessionOnce(); // asked for after s2: it waits for s2
    const s3 = switchOrg('org-2'); // asked for after the renewal: it waits for the renewal
    await tick();
    expect(s.calls).toHaveLength(1);
    s.release('switch#1');
    await Promise.all([s1, s2, r, s3]); // a cycle (the later switch waiting for a renewal that waits for it) would hang here
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org', 'switch-project', 'refresh', 'switch-org']);
    expect(s.maxActive()).toBe(1);
  });

  it('a switch whose request fails (network) does not block the next switch or a renewal', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      n += 1;
      if (n === 1) throw new Error('network');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }));
    await expect(switchOrg('org-1')).rejects.toThrow('network'); // the caller sees the failure as before
    expect((await switchProject('proj-1')).ok).toBe(true);
    await refreshSessionOnce();
    expect(n).toBe(3);
  });

  it('a plain switch (no withAuth) hands a 401 back as it is — no renewal, no session-expired signal (what the plain fetch did)', async () => {
    const s = scripted({ switchStatuses: [401] });
    const res = await switchOrg('org-1');
    expect(res.status).toBe(401);
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org']);
    expect(isSessionExpiredSignaled()).toBe(false);
  });

  it('withAuth: a 401 renews through the flight and asks once more (what fetchWithAuth did for these callers)', async () => {
    const s = scripted({ switchStatuses: [401, 200] });
    const res = await switchOrg('org-1', { withAuth: true });
    expect(res.status).toBe(200);
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org', 'refresh', 'switch-org']);
    expect(s.maxActive()).toBe(1);
  });

  it('withAuth: a renewal that fails hands the 401 back and signals the session ended', async () => {
    const s = scripted({ switchStatuses: [401], refreshStatuses: [401] });
    const res = await switchOrg('org-1', { withAuth: true });
    expect(res.status).toBe(401);
    expect(s.calls.map((c) => c.kind)).toEqual(['switch-org', 'refresh']); // no second switch
    expect(isSessionExpiredSignaled()).toBe(true);
  });

  it('withAuth after the session was signalled dead: no network at all', async () => {
    const s = scripted();
    const { signalSessionExpired } = await import('@/lib/auth/session-expired-signal');
    signalSessionExpired();
    const res = await switchOrg('org-1', { withAuth: true });
    expect(res.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });
});
