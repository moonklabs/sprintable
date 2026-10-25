// @vitest-environment jsdom
//
// story 4773 (AC3, PO 10-25) — where the pairing card sits on Today: the TOP band (above the title and above the redirect-back banner), so the instruction box keeps the place hands
// know and the 4762 AC3 test (Send clear of the support button) is not disturbed. Outside the phone app the shell is what it was (no card · nothing asked of the bridge).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock, searchParamsValueRef } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  searchParamsValueRef: { current: '' as string },
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
  usePathname: () => '/org-briefing',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchParamsValueRef.current = '';
  useDashboardContextMock.mockReturnValue({ projectId: 'p1', projectMemberships: [], orgMemberships: [], inShell: true });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const EMPTY_TODAY = {
  needs_me: [], needs_me_count: 0, agent_progress: [],
  published_today: { count: 0, by_channel: [] }, usage: { platform: [], ad_spend: { measured: false } },
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function stubServer(devices: Array<{ id: string; confirm_number: string }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/today') return ok({ data: EMPTY_TODAY });
    if (url === '/api/remote-devices') return ok({ devices });
    return ok({ data: null });
  }));
}

async function mount(opts: { inPhoneApp: boolean; call?: ReturnType<typeof vi.fn> }) {
  const phoneCall = (opts.call ?? vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }))) as unknown as (t: string, a?: Record<string, unknown>) => Promise<{ id: string; ok: boolean }>;
  // the shell and the context come from the SAME module copy: `vi.resetModules()` (afterEach) makes the next import a new copy, and a context imported at the top would be another object — the shell would read «not the phone app» (the same trap as 5219)
  const { OrgBriefingShell } = await import('./org-briefing-shell');
  const { PhoneBridgeContext } = await import('@/components/providers/phone-bridge-context');
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: opts.inPhoneApp, phoneCall }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><OrgBriefingShell /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); // b comes after a

describe('[SID:4773] Today — the pairing card is the top band', () => {
  it('phone app + paired with nothing → the card is the first thing on Today: before the title, before the redirect-back banner, before the instruction box', async () => {
    stubServer([]);
    searchParamsValueRef.current = 'next=%2Fglance'; // the redirect-back banner is on too
    await mount({ inPhoneApp: true });
    const card = q('today-pair-card');
    expect(card).not.toBeNull(); // reverted (not in the shell) → fails
    const h1 = container.querySelector('h1')!;
    const banner = container.querySelector('[role="status"]')!;
    const form = q('today-instruction-form')!;
    expect(before(card!, h1)).toBe(true);
    expect(before(card!, banner)).toBe(true); // top band, not under the title or the banner
    expect(before(card!, form)).toBe(true);
    expect(card!.parentElement?.firstElementChild).toBe(card); // the very first child of the page column
  });

  it('the instruction box is where it was: still the last block, after the sections (the card moved nothing below it)', async () => {
    stubServer([]);
    await mount({ inPhoneApp: true });
    const form = q('today-instruction-form')!;
    const card = q('today-pair-card')!;
    expect(before(card, form)).toBe(true);
    expect(form.closest('.sticky')?.parentElement?.lastElementChild).toBe(form.closest('.sticky')); // the sticky bottom row is still the last child of the column
  });

  it('outside the phone app Today is what it was: no card, and the bridge is not asked', async () => {
    stubServer([]);
    const call = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
    await mount({ inPhoneApp: false, call });
    expect(q('today-pair-card')).toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toBe('오늘');
  });

  it('a paired phone: Today has no card (and the read did run — the phone app was asked, so this is not «never looked»)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/today') return ok({ data: EMPTY_TODAY });
      if (url === '/api/remote-devices') return ok({ devices: [{ id: 'd1', confirm_number: '324 642' }] });
      if (url.startsWith('/api/desktop/startable')) return ok({ remote_control: true, computers: [] });
      return ok({ data: null });
    }));
    const call = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
    await mount({ inPhoneApp: true, call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(q('today-pair-card')).toBeNull();
  });
});
