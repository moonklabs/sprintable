// @vitest-environment jsdom
// story 5031 (C1 step 5c · PO ii) — the home's «detail beside the list» is decided by the width the BODY received (≥ 340 + 16 + 360 = 716), on top of the usual lg rule. The first render says «not beside» (the sheet) — same as the server;
// the width is then read and followed (ResizeObserver, stubbed here — jsdom has none and no layout).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HOME_TWO_COLUMN_MIN, HOME_DETAIL_W, HOME_GAP, HOME_LIST_MIN } from '@/components/home/home-layout';
import { useDetailBesideList } from './use-detail-beside-list';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roState = vi.hoisted(() => ({ callbacks: [] as Array<() => void>, width: 0 }));
class FakeRO { constructor(cb: () => void) { roState.callbacks.push(cb); } observe() {} unobserve() {} disconnect() { roState.callbacks.length = 0; } }

let container: HTMLDivElement;
let root: Root;
const renders: boolean[] = [];
function Probe() {
  const { ref, wide } = useDetailBesideList(HOME_TWO_COLUMN_MIN);
  renders.push(wide);
  return <div ref={ref} data-testid="body">{String(wide)}</div>;
}
const media = (matches: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
const setWidth = (w: number) => { roState.width = w; vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: roState.width, height: 0, top: 0, left: 0, right: roState.width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) })); };
const text = () => container.textContent;

beforeEach(() => { renders.length = 0; roState.callbacks.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the named numbers', () => {
  it('⭐716 = the detail 340 + the gap 16 + the list\'s least 360 (one place, named)', () => {
    expect([HOME_DETAIL_W, HOME_GAP, HOME_LIST_MIN, HOME_TWO_COLUMN_MIN]).toEqual([340, 16, 360, 716]);
  });
});

describe('useDetailBesideList', () => {
  it('⭐the body at 715 → not beside (sheet) · at 716 → beside; it follows a resize both ways', async () => {
    vi.stubGlobal('ResizeObserver', FakeRO); media(true);
    setWidth(715);
    await act(async () => { root.render(<Probe />); });
    expect(text()).toBe('false');
    setWidth(716);
    await act(async () => { for (const cb of roState.callbacks) cb(); });
    expect(text()).toBe('true');
    setWidth(715);
    await act(async () => { for (const cb of roState.callbacks) cb(); });
    expect(text()).toBe('false');
  });

  it('the very first render says «not beside» even when the body is wide (the server\'s answer — no hydration mismatch); the measured answer follows before anything is painted', async () => {
    vi.stubGlobal('ResizeObserver', FakeRO); media(true);
    setWidth(900);
    await act(async () => { root.render(<Probe />); });
    expect(renders[0]).toBe(false);
    expect(renders.at(-1)).toBe(true);
  });

  it('the usual lg rule still comes first: a wide body in a window below 1024 is not beside', async () => {
    vi.stubGlobal('ResizeObserver', FakeRO); media(false);
    setWidth(900);
    await act(async () => { root.render(<Probe />); });
    expect(text()).toBe('false');
  });

  it('no ResizeObserver (a test · an old browser): the usual rule alone, as before', async () => {
    vi.stubGlobal('ResizeObserver', undefined); media(true);
    await act(async () => { root.render(<Probe />); });
    expect(text()).toBe('true');
  });
});
