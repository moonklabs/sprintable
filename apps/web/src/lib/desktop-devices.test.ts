import { describe, expect, it } from 'vitest';
import { canDisconnect, canManageDevices, deviceAgentCount, markDisconnected, orderDevices, readDevices, readRevoked, type DesktopDevice } from './desktop-devices';

const d = (setup_id: string, state: DesktopDevice['state']): DesktopDevice => ({
  setup_id, device_name: setup_id, state, confirmed_at: null, revoked_at: null, active_keys: 1, members: [{ kind: 'agent' }, { kind: 'human' }],
});

describe('desktop devices rules (4424)', () => {
  it('only an owner/admin manages devices', () => {
    expect(['owner', 'admin', 'member', undefined].map(canManageDevices)).toEqual([true, true, false, false]);
  });
  it('counts agents only, not the person', () => expect(deviceAgentCount(d('a', 'handed_over'))).toBe(1));
  it('counts distinct agents, not their stages (one agent over four stages is one — Qadir 4830 ②)', () => {
    const members = [
      ...['draft', 'edit', 'review', 'publish'].map(() => ({ kind: 'agent' as const, member_id: 'agent-1' })),
      { kind: 'agent' as const, member_id: 'agent-2' }, { kind: 'human' as const, member_id: 'person' },
    ];
    expect(deviceAgentCount({ ...d('a', 'handed_over'), members })).toBe(2);
  });
  it('a disconnected device cannot be disconnected again', () => {
    expect(canDisconnect(d('a', 'disconnected'))).toBe(false);
    expect(canDisconnect(d('a', 'not_handed_over'))).toBe(true);
  });
  it('connected first, disconnected last, order otherwise kept', () => {
    expect(orderDevices([d('x', 'disconnected'), d('a', 'handed_over'), d('b', 'waiting_for_app')]).map((v) => v.setup_id)).toEqual(['a', 'b', 'x']);
  });
  it('marking one disconnected takes the server\'s when · who and leaves the others untouched', () => {
    const out = markDisconnected([d('a', 'handed_over'), d('b', 'handed_over')], 'a', { already: true, revokedAt: '2026-09-29T00:00:00Z', revokedByName: '박서연' });
    expect(out.map((v) => [v.state, v.active_keys, v.revoked_at, v.revoked_by_name ?? null])).toEqual([
      ['disconnected', 0, '2026-09-29T00:00:00Z', '박서연'], ['handed_over', 1, null, null],
    ]);
  });
  it('the DELETE answer: already or not, and the setup\'s own when · who; anything else is null', async () => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    expect(await readRevoked(ok({ revoked_keys: 0, already_disconnected: true, revoked_at: '2026-09-29T00:00:00Z', revoked_by_name: '박서연' })))
      .toEqual({ already: true, revokedAt: '2026-09-29T00:00:00Z', revokedByName: '박서연' });
    expect(await readRevoked(ok({ revoked_keys: 2, already_disconnected: false, revoked_at: '2026-09-30T00:00:00Z', revoked_by_name: null })))
      .toEqual({ already: false, revokedAt: '2026-09-30T00:00:00Z', revokedByName: null });
    expect(await readRevoked(ok({ revoked_keys: 2 }))).toBeNull(); // an older answer without the fields
    expect(await readRevoked(new Response('not json', { status: 200 }))).toBeNull();
  });
  it('a 403 or an unreadable answer is null (the section hides)', async () => {
    expect(await readDevices(new Response('{}', { status: 403 }))).toBeNull();
    // not ok is never read as a list, whatever the body says
    expect(await readDevices(new Response(JSON.stringify({ setups: [] }), { status: 500 }))).toBeNull();
    expect(await readDevices(new Response('not json', { status: 200 }))).toBeNull();
    expect(await readDevices(new Response(JSON.stringify({ setups: [] }), { status: 200 }))).toEqual([]);
  });
});

describe('device dates (Yuna: like the notifications)', () => {
  it('this year: month and day; another year: with the year', async () => {
    const { deviceDateOptions } = await import('./desktop-devices');
    const now = new Date('2026-09-30T00:00:00Z');
    expect(deviceDateOptions('2026-09-29T10:00:00Z', now, 'Asia/Seoul')).toEqual({ month: 'long', day: 'numeric' });
    expect(deviceDateOptions('2025-12-01T10:00:00Z', now, 'Asia/Seoul')).toEqual({ year: 'numeric', month: 'long', day: 'numeric' });
    // story #4443 PR3a — «this year» is the named zone's: 2025-12-31T20:00Z is already 2026 in Seoul, still 2025 in UTC
    expect(deviceDateOptions('2025-12-31T20:00:00Z', new Date('2026-06-01T00:00:00Z'), 'Asia/Seoul')).toEqual({ month: 'long', day: 'numeric' });
    expect(deviceDateOptions('2025-12-31T20:00:00Z', new Date('2026-06-01T00:00:00Z'), 'UTC')).toEqual({ year: 'numeric', month: 'long', day: 'numeric' });
  });
});
