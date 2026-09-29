import { describe, expect, it } from 'vitest';
import { canDisconnect, canManageDevices, deviceAgentCount, markDisconnected, orderDevices, readDevices, type DesktopDevice } from './desktop-devices';

const d = (setup_id: string, state: DesktopDevice['state']): DesktopDevice => ({
  setup_id, device_name: setup_id, state, confirmed_at: null, revoked_at: null, active_keys: 1, members: [{ kind: 'agent' }, { kind: 'human' }],
});

describe('desktop devices rules (4424)', () => {
  it('only an owner/admin manages devices', () => {
    expect(['owner', 'admin', 'member', undefined].map(canManageDevices)).toEqual([true, true, false, false]);
  });
  it('counts agents only, not the person', () => expect(deviceAgentCount(d('a', 'handed_over'))).toBe(1));
  it('a disconnected device cannot be disconnected again', () => {
    expect(canDisconnect(d('a', 'disconnected'))).toBe(false);
    expect(canDisconnect(d('a', 'not_handed_over'))).toBe(true);
  });
  it('connected first, disconnected last, order otherwise kept', () => {
    expect(orderDevices([d('x', 'disconnected'), d('a', 'handed_over'), d('b', 'waiting_for_app')]).map((v) => v.setup_id)).toEqual(['a', 'b', 'x']);
  });
  it('marking one disconnected leaves the others untouched', () => {
    const out = markDisconnected([d('a', 'handed_over'), d('b', 'handed_over')], 'a', '2026-09-29T00:00:00Z');
    expect(out.map((v) => [v.state, v.active_keys])).toEqual([['disconnected', 0], ['handed_over', 1]]);
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
    expect(deviceDateOptions('2026-09-29T10:00:00Z', now)).toEqual({ month: 'long', day: 'numeric' });
    expect(deviceDateOptions('2025-12-01T10:00:00Z', now)).toEqual({ year: 'numeric', month: 'long', day: 'numeric' });
  });
});
