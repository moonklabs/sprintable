// @vitest-environment jsdom
//
// story 4993 · audit 4 — the hook's REAL clock and visibility (`browserEnv`): every other keeper test hands the keeper its own `visible` and `onVisibility`, so the page's `document.visibilityState` / `visibilitychange` wiring could be wrong and all of them stay green (found by the mutant `visible: () => true`).
// A screen the person hid keeps the road for the grace (10 s) and then closes it; coming back opens/pings again. Each check goes red without the line it names.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';
import type { PhoneAnswer } from '@/lib/phone-bridge';
import { DIRECT_KEEP_EVERY_MS, DIRECT_KEEP_GRACE_MS, __resetDirectKeepForTest } from '@/lib/phone-direct-keep';
import { useDirectRoad } from './use-direct-road';

const SETUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const calls: string[] = [];
const phoneCall = vi.fn(async (type: string): Promise<PhoneAnswer> => {
  calls.push(type);
  if (type === 'shell.caps') return { id: 'c', ok: true, caps: { direct: 1, direct_keep: 1 } };
  if (type === 'direct.keep') return { id: 'k', state: 'ready' } as unknown as PhoneAnswer;
  return { id: 'x', ok: true };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Probe(): ReactNode { useDirectRoad(SETUP); return null; }
let root: Root | null = null; let container: HTMLElement | null = null;
const setVisibility = (v: 'visible' | 'hidden') => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => { vi.useFakeTimers(); calls.length = 0; phoneCall.mockClear(); });
afterEach(async () => { if (root) await act(async () => { root!.unmount(); }); root = null; container?.remove(); container = null; __resetDirectKeepForTest(); setVisibility('visible'); vi.useRealTimers(); });

describe('[4993 audit 4] the page hides: the road is closed after the grace and kept again when it is back', () => {
  it('hidden → after the grace `direct.close`, and no more `direct.keep`; visible again → `direct.keep` again', async () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<PhoneBridgeContext.Provider value={{ inPhoneApp: true, phoneCall }}><Probe /></PhoneBridgeContext.Provider>); });
    await vi.advanceTimersByTimeAsync(1); expect(calls).toEqual(['shell.caps', 'direct.keep']);
    await act(async () => { setVisibility('hidden'); });
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_GRACE_MS - 1000); expect(calls.filter((c) => c === 'direct.close'), 'not yet: the grace is not over').toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000); expect(calls.filter((c) => c === 'direct.close')).toHaveLength(1);
    const keeps = calls.filter((c) => c === 'direct.keep').length;
    await vi.advanceTimersByTimeAsync(DIRECT_KEEP_EVERY_MS * 3); expect(calls.filter((c) => c === 'direct.keep')).toHaveLength(keeps); // (hidden: nothing is asked)
    await act(async () => { setVisibility('visible'); });
    await vi.advanceTimersByTimeAsync(1); expect(calls.filter((c) => c === 'direct.keep').length).toBeGreaterThan(keeps);
  });
});
