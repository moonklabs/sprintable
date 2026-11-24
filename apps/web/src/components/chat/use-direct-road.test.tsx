// @vitest-environment jsdom
//
// story 4993 (PO ⓐ) — the hook that mounts the keeper (lib/phone-direct-keep.ts) on a screen of one computer: only inside the phone app, only with a computer to ask about, and it lets go when the screen goes.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneBridgeContext, type PhoneBridgeValue } from '@/components/providers/phone-bridge-context';
import type { PhoneAnswer } from '@/lib/phone-bridge';
import { DIRECT_KEEP_EVERY_MS, DIRECT_KEEP_GRACE_MS, __resetDirectKeepForTest } from '@/lib/phone-direct-keep';
import { useDirectRoad } from './use-direct-road';

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
