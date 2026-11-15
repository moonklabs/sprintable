// @vitest-environment jsdom
//
// story 4891 (UI-8 AC4 · first screen rebuild) — on a phone the settings list comes FIRST: arriving at /settings with no ?tab= the list is the whole screen (the pane is hidden) and a section opens into the pane with a back row;
// arriving by a link with ?tab= goes straight to that pane (back row to the list). ≥lg the list is always beside the pane (CSS — the classes below are what decide it). Harness as page.this-phone.4762.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, params } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), params: { current: new URLSearchParams('') } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => params.current,
  usePathname: () => '/settings',
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn(async () => ({ ok: false, json: async () => ({ data: null }) })) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ data: null }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function draw(query: string) {
  params.current = new URLSearchParams(query);
  const { default: SettingsPage } = await import('./page');
  const { PhoneBridgeContext } = await import('@/components/providers/phone-bridge-context');
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: false, phoneCall: vi.fn() }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}
const navColumn = () => container.querySelector<HTMLElement>('[data-testid="settings-nav-column"]')!;
const pane = () => container.querySelector<HTMLElement>('[data-testid="settings-pane"]')!;
const listIsTheScreen = () => !navColumn().className.split(' ').includes('hidden') && pane().className.split(' ').includes('hidden');
const paneIsTheScreen = () => navColumn().className.split(' ').includes('hidden') && !pane().className.split(' ').includes('hidden');
const back = () => container.querySelector<HTMLButtonElement>(`[data-testid="settings-back-row"] button[aria-label="${koMessages.settings.backToList}"]`);

describe('SettingsPage — a phone sees the list first (story 4891)', () => {
  it('⭐arriving with no ?tab=: the list is the whole screen (the pane is hidden below lg)', async () => {
    await draw('');
    expect(listIsTheScreen()).toBe(true);
    expect(container.querySelectorAll('[role="tab"]').length).toBeGreaterThan(6);
  });

  it('⭐arriving with ?tab=: straight to that pane, with a back row that names where you are and returns to the list', async () => {
    await draw('tab=appearance');
    expect(paneIsTheScreen()).toBe(true);
    const row = container.querySelector('[data-testid="settings-back-row"]')!;
    expect(row.textContent).toContain(koMessages.settings.tabDisplay);
    await act(async () => { back()!.click(); });
    expect(listIsTheScreen()).toBe(true);
  });

  it('⭐from the list a section opens into the pane (and is the selected one)', async () => {
    await draw('');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-tab="appearance"]')!.click(); });
    expect(paneIsTheScreen()).toBe(true);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabDisplay);
  });

  it('⭐the lg rules that keep a wide screen unchanged: the list column is always a flex column beside the pane, and the pane — hidden on a phone while the list is the screen — comes back at lg', async () => {
    await draw('');
    expect(navColumn().className).toContain('lg:flex');
    expect(pane().className).toContain('hidden lg:block');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-settings-tab="appearance"]')!.click(); });
    expect(navColumn().className).toContain('lg:flex'); // the list stays beside the pane at lg even when a phone has gone into the pane
  });
});

describe('SettingsPage — a link while the list is up (codex round 1)', () => {
  it('⭐the link changing to ?tab=… opens that pane (not the row selected behind a hidden pane) and back to no ?tab= is the list again', async () => {
    await draw('');
    expect(listIsTheScreen()).toBe(true);
    const { default: SettingsPage } = await import('./page');
    const { PhoneBridgeContext } = await import('@/components/providers/phone-bridge-context');
    const redraw = async (query: string) => {
      params.current = new URLSearchParams(query); // a NEW object = the link changed, as in the app
      await act(async () => {
        root.render(
          <PhoneBridgeContext.Provider value={{ inPhoneApp: false, phoneCall: vi.fn() }}>
            <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
          </PhoneBridgeContext.Provider>,
        );
      });
      await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
    };
    await redraw('tab=appearance');
    expect(paneIsTheScreen()).toBe(true);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabDisplay);
    await redraw('');
    expect(listIsTheScreen()).toBe(true);
  });
});
