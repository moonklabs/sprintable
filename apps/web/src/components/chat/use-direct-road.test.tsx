// @vitest-environment jsdom
//
// story 4993 (PO ⓐ) — the hook that mounts the keeper (lib/phone-direct-keep.ts) on a screen of one computer: only inside the phone app, only with a computer to ask about, and it lets go when the screen goes.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneBridgeContext, type PhoneBridgeValue } from '@/components/providers/phone-bridge-context';
import type { PhoneAnswer } from '@/lib/phone-bridge';
import { DIRECT_KEEP_EVERY_MS, DIRECT_KEEP_GRACE_MS, __resetDirectKeepForTest } from '@/lib/phone-direct-keep';
import { useDirectRoad, useDirectRoads } from './use-direct-road';

const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const calls: string[] = [];
const phoneCall = vi.fn(async (type: string): Promise<PhoneAnswer> => {
  calls.push(type);
  if (type === 'shell.caps') return { id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } };
  if (type === 'direct.keep') return { id: 'k', state: 'ready' } as unknown as PhoneAnswer; // (the real shell's answer has no `ok`: the contract's {state})
  return { id: 'x', ok: true };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Probe({ setupId }: { setupId: string | undefined }): ReactNode { useDirectRoad(setupId); return null; }
function ProbeMany({ ids }: { ids: readonly (string | undefined)[] }): ReactNode { useDirectRoads(ids); return null; }
let root: Root | null = null; let container: HTMLElement | null = null;
/** mount a screen of the computer inside (or outside) the phone app; returns the way to take it away and to render it again */
async function mount(value: PhoneBridgeValue, setupId: string | undefined) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const draw = () => <PhoneBridgeContext.Provider value={value}><Probe setupId={setupId} /></PhoneBridgeContext.Provider>;
  await act(async () => { root!.render(draw()); });
  return { rerender: async () => { await act(async () => { root!.render(draw()); }); }, unmount: async () => { await act(async () => { root!.unmount(); }); root = null; container?.remove(); container = null; } };
}

beforeEach(() => { vi.useFakeTimers(); calls.length = 0; phoneCall.mockClear(); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; container?.remove(); container = null; __resetDirectKeepForTest(); vi.useRealTimers(); });

describe('[4993 ⓐ] useDirectRoad', () => {
  it('outside the phone app it asks the shell nothing', async () => {
    await mount({ inPhoneApp: false, phoneCall }, SETUP);
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS * 3); expect(calls).toEqual([]);
  });

  it('without a computer (no setup id) it asks nothing, even inside the phone app', async () => {
    await mount({ inPhoneApp: true, phoneCall }, undefined);
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS * 3); expect(calls).toEqual([]);
  });

  it('inside the phone app with a computer: it asks at once and every 30 s (`direct.keep`), and when the screen goes it closes the road after the grace', async () => {
    const { unmount } = await mount({ inPhoneApp: true, phoneCall }, SETUP);
    await vi.advanceTimersByTimeAsync(1); expect(calls).toEqual(['shell.caps', 'direct.keep']);
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS); expect(calls.filter((c) => c === 'direct.keep')).toHaveLength(2);
    await unmount(); const before = calls.length; await vi.advanceTimersByTimeAsync(DIRECT_KEEP_GRACE_MS); expect(calls.slice(before)).toEqual(['direct.close']);
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS * 3); expect(calls.filter((c) => c === 'direct.keep')).toHaveLength(2); // (nothing more once the screen is gone)
  });

  it('the screen re-rendering with the same computer does not start a second keeper', async () => {
    const { rerender, unmount } = await mount({ inPhoneApp: true, phoneCall }, SETUP);
    await vi.advanceTimersByTimeAsync(1); await rerender(); await rerender(); await vi.advanceTimersByTimeAsync(1); expect(calls.filter((c) => c === 'shell.caps')).toHaveLength(1); await unmount();
  });
});

describe('[4993 ⓐ-3] useDirectRoads: the computers of the screens that are in front', () => {
  const A = '0f0e0d0c-0b0a-4908-8706-050403020100'; const B = '11111111-2222-4333-8444-555555555555';
  const keepsFor = (id: string) => phoneCall.mock.calls.filter((c) => c[0] === 'direct.keep' && (c as unknown as [string, { setup_id: string }])[1].setup_id === id).length;
  async function mountMany(value: PhoneBridgeValue, ids: readonly (string | undefined)[]) {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    const draw = (x: readonly (string | undefined)[]) => <PhoneBridgeContext.Provider value={value}><ProbeMany ids={x} /></PhoneBridgeContext.Provider>;
    await act(async () => { root!.render(draw(ids)); });
    return { set: async (x: readonly (string | undefined)[]) => { await act(async () => { root!.render(draw(x)); }); }, unmount: async () => { await act(async () => { root!.unmount(); }); root = null; container?.remove(); container = null; } };
  }
  it('outside the phone app nothing is asked about any computer of the list', async () => {
    await mountMany({ inPhoneApp: false, phoneCall }, [A, B]); await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS * 3); expect(calls).toEqual([]);
  });
  it('each computer of the list is held (duplicates and empty ids ignored)', async () => {
    await mountMany({ inPhoneApp: true, phoneCall }, [A, B, A, undefined, '']); await vi.advanceTimersByTimeAsync(1); expect(keepsFor(A)).toBe(1); expect(keepsFor(B)).toBe(1); expect(calls.filter((c) => c === 'shell.caps')).toHaveLength(2);
  });
  it('a computer that leaves the list is let go (its road closed after the grace); one that stays is not touched — no new look, no second keeper', async () => {
    const m = await mountMany({ inPhoneApp: true, phoneCall }, [A, B]); await vi.advanceTimersByTimeAsync(1); const a0 = keepsFor(A); const caps0 = calls.filter((c) => c === 'shell.caps').length;
    await m.set([A]); await vi.advanceTimersByTimeAsync(1); expect(keepsFor(A), 'A: no extra look').toBe(a0); expect(calls.filter((c) => c === 'direct.close')).toEqual([]);
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_GRACE_MS); expect(calls.filter((c) => c === 'direct.close')).toHaveLength(1); expect(phoneCall.mock.calls.filter((c) => c[0] === 'direct.close').map((c) => (c as unknown as [string, { setup_id: string }])[1].setup_id)).toEqual([B]);
    await m.set([A, B]); await vi.advanceTimersByTimeAsync(1); expect(calls.filter((c) => c === 'shell.caps').length, 'B asked again as it comes back (a new keeper)').toBe(caps0 + 1); await m.unmount();
  });
  it('the same list again (a re-render) changes nothing; a screen of the same computer elsewhere shares the keeper (one road)', async () => {
    const m = await mountMany({ inPhoneApp: true, phoneCall }, [A]); await vi.advanceTimersByTimeAsync(1); const n = calls.length;
    await m.set([A]); await m.set([A]); await vi.advanceTimersByTimeAsync(1); expect(calls.length).toBe(n);
    const other = document.createElement('div'); document.body.appendChild(other); const root2 = createRoot(other);
    await act(async () => { root2.render(<PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall }}><Probe setupId={A} /></PhoneBridgeContext.Provider>); }); await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((c) => c === 'shell.caps')).toHaveLength(1); await act(async () => { root2.unmount(); }); other.remove(); await m.unmount();
  });
});
