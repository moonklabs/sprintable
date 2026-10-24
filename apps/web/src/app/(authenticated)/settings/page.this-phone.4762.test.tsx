// @vitest-environment jsdom
//
// story 4762 — the settings tab «이 폰»: listed (and openable by ?tab=this-phone) only inside the phone app, where it shows the phone's check number. In a browser
// the tab is not drawn and a link to it lands on the default tab (no empty pane). Harness as page.desktop-tab.4668.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, searchParams } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), searchParams: new URLSearchParams('tab=this-phone') }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchParams, // ONE object, as in the app: a fresh one per render would re-run the page's tab effect every render and hide a missing dependency
  usePathname: () => '/settings',
}));
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: false, json: async () => ({ data: null }) })),
}));

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
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// after `vi.resetModules()` (afterEach) a fresh import of the page gets a fresh copy of the bridge context module: the provider must come from the SAME copy as the page's
async function load() {
  const { default: SettingsPage } = await import('./page');
  const { PhoneBridgeContext } = await import('@/components/providers/phone-bridge-context');
  return { SettingsPage, PhoneBridgeContext };
}

async function drawPage(inPhoneApp: boolean) {
  const phoneCall = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
  const { SettingsPage, PhoneBridgeContext } = await load();
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp, phoneCall }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return phoneCall;
}
const tabNames = () => Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent?.trim());

describe('[SID:4762] SettingsPage — «이 폰» tab', () => {
  it('a phone claim that comes AFTER the first render still lands the ?tab=this-phone link on its tab (the tab did not exist at first; the page follows the claim)', async () => {
    const phoneCall = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
    const { SettingsPage, PhoneBridgeContext } = await load();
    const draw = (inPhoneApp: boolean) => act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp, phoneCall }}>
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await draw(false);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabProfile); // first render: not the phone app yet
    await draw(true); // the claim arrives
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabThisPhone); // reverted (no dependency) → stays on the profile tab
    expect(container.querySelector('[data-testid=this-phone-number]')?.textContent).toBe('324 642');
  });

  it('the person is on «이 폰» by their own pick and the phone bridge goes away: the page falls back to the default tab (the tab list never points at a pane that is gone)', async () => {
    const phoneCall = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
    const { SettingsPage, PhoneBridgeContext } = await load();
    const draw = (inPhoneApp: boolean) => act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp, phoneCall }}>
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await draw(true);
    const own = Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === koMessages.settings.tabThisPhone) as HTMLElement;
    await act(async () => { own.click(); });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabThisPhone);
    await draw(false);
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(tabNames()).not.toContain(koMessages.settings.tabThisPhone);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabProfile); // reverted → the selection points at a tab that is gone
  });

  it('a tab the person picked by hand before the claim arrives is kept — the late claim does not pull them back to the link\'s tab', async () => {
    const phoneCall = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
    const { SettingsPage, PhoneBridgeContext } = await load();
    const draw = (inPhoneApp: boolean) => act(async () => {
      root.render(
        <PhoneBridgeContext.Provider value={{ inPhoneApp, phoneCall }}>
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>
        </PhoneBridgeContext.Provider>,
      );
    });
    await draw(false);
    const display = Array.from(container.querySelectorAll('[role="tab"]')).find((el) => el.textContent?.trim() === koMessages.settings.tabDisplay) as HTMLElement;
    await act(async () => { display.click(); });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabDisplay);
    await draw(true); // the claim arrives
    await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
    expect(tabNames()).toContain(koMessages.settings.tabThisPhone); // the tab exists now …
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabDisplay); // … and the person stays where they chose to be
  });

  it('inside the phone app: the tab is listed and ?tab=this-phone shows the phone\'s check number', async () => {
    const call = await drawPage(true);
    expect(tabNames()).toContain(koMessages.settings.tabThisPhone); // reverted (no trigger) → fails
    expect(container.querySelector('[data-testid=settings-this-phone-tab]')).not.toBeNull();
    expect(container.querySelector('[data-testid=this-phone-number]')?.textContent).toBe('324 642');
    expect(call).toHaveBeenCalledWith('device.key.info', {});
  });

  it('in a browser: no tab, and a link to ?tab=this-phone lands on the default tab — no card, no bridge call', async () => {
    const call = await drawPage(false);
    expect(tabNames()).not.toContain(koMessages.settings.tabThisPhone);
    // the link landed on the default tab (it is the ACTIVE one) — not on an empty pane with no tab selected
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()).toBe(koMessages.settings.tabProfile);
    // and the default tab's pane is the one on screen (an unresolved link would leave the tab list pointing at a pane that does not exist)
    expect(container.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid=settings-this-phone-tab]')).toBeNull();
    expect(container.querySelector('[data-testid=this-phone-card]')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });
});
