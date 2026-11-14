// @vitest-environment jsdom
//
// story 4906 (PO 11-14) — the strip gives the support button's corner back ONLY where the PANE is wide enough that the body column ends before the button's box (pane ≥ the column's own max-width + 2 × (48 + 16)). A toast lifts the
// button into the row's right end on a narrow pane, so the corner (`pe-14` behind `<html data-support-launcher>`) must stay there. This pins the hook's decisions (jsdom has no layout: the pane's width is set by hand);
// the real boxes — sidebar open / folded × 1100 · 1280 · 1440 × 0 · 1 · 2 toasts — are in e2e/home-instruction-strip.4906.layout.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: null, currentTeamMemberId: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEEP = '[:root[data-support-launcher]_&]:pe-14';
const CAP = 896; // the column's own max-width (max-w-4xl) — the test column carries it as an inline style, the hook reads it from the computed style
const SPAN = 64; // the button's 48px + the dock's 16px offset

let container: HTMLDivElement;
let root: Root;
let observers: Array<{ cb: () => void; observed: Element | null }>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  observers = [];
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubResizeObserver() {
  vi.stubGlobal('ResizeObserver', class { cb: () => void; observed: Element | null = null; constructor(cb: () => void) { this.cb = cb; observers.push(this); } observe(el: Element) { this.observed = el; } unobserve() {} disconnect() {} });
}

/** the body pane (a scroller) → the capped column → the strip, with the pane's width set by hand */
async function mount(paneWidth: number, colMaxWidth: string = `${CAP}px`) {
  const { InstructionStrip } = await import('./instruction-strip');
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  Object.defineProperty(pane, 'clientWidth', { value: paneWidth, configurable: true, writable: true });
  const column = document.createElement('div');
  column.style.maxWidth = colMaxWidth;
  pane.appendChild(column);
  container.appendChild(pane);
  const hostRoot = createRoot(column); // the strip is the column's direct child (as in the shell: the body root div holds it)
  await act(async () => {
    hostRoot.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><InstructionStrip autoFocus={false} /></NextIntlClientProvider>,
    );
  });
  return { pane, hostRoot };
}
const form = () => container.querySelector('[data-testid="today-instruction-form"]') as HTMLElement;
const keeps = () => form().className.includes(KEEP);

describe('InstructionStrip — the support button\'s corner follows the PANE width (4906)', () => {
  it('⭐ a pane wide enough (≥ the column\'s max-width + 2 × the button\'s reach) gives the corner back', async () => {
    stubResizeObserver();
    await mount(CAP + 2 * SPAN);
    expect(keeps()).toBe(false); // reverted (never given back) → RED
  });

  it('⭐ one pixel short of that keeps it — the button can still meet the row', async () => {
    stubResizeObserver();
    await mount(CAP + 2 * SPAN - 1);
    expect(keeps()).toBe(true); // reverted (threshold without the button\'s reach) → the corner is given back too early → RED
  });

  it('⭐ the sidebar folding / unfolding changes the PANE\'s width and the corner follows — both ways', async () => {
    stubResizeObserver();
    const { pane } = await mount(1100);
    expect(keeps()).toBe(false);
    Object.defineProperty(pane, 'clientWidth', { value: 780, configurable: true });
    await act(async () => { observers[0]!.cb(); });
    expect(keeps()).toBe(true);
    Object.defineProperty(pane, 'clientWidth', { value: 1200, configurable: true });
    await act(async () => { observers[0]!.cb(); });
    expect(keeps()).toBe(false);
  });

  it('⭐ without a ResizeObserver one reading is not trusted: the corner stays kept even on a wide pane (it would go stale when the sidebar folds)', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    await mount(1300);
    expect(keeps()).toBe(true); // reverted (measure before the observer check) → given back and never taken back → RED
  });

  it('a column with no cap (`max-width: none`) keeps the corner — there is no edge to compare', async () => {
    stubResizeObserver();
    await mount(2000, 'none');
    expect(keeps()).toBe(true);
  });

  it('the failure line keeps the corner exactly when the row does (same decision)', async () => {
    stubResizeObserver();
    await mount(600);
    expect(keeps()).toBe(true);
  });
});
