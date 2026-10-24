// @vitest-environment jsdom
//
// story 4762 — the settings tab «이 폰»: listed (and openable by ?tab=this-phone) only inside the phone app, where it shows the phone's check number. In a browser
// the tab is not drawn and a link to it lands on the default tab (no empty pane). Harness as page.desktop-tab.4668.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { PhoneBridgeContext } from '@/components/providers/phone-bridge-context';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=this-phone'),
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

async function drawPage(inPhoneApp: boolean) {
  const phoneCall = vi.fn(async () => ({ id: 'w1', ok: true, key_number: '324 642' }));
  const { default: SettingsPage } = await import('./page');
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
