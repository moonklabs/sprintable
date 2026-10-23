// @vitest-environment jsdom
//
// story 4668 (PO Q-b · Yuna A-4 · design §4 T10) — the settings tab «데스크톱 앱 받기»: where the onboarding's download screen is
// reopened. The card (and the phone card on a device that is not a Mac) only, and no DESKTOP_DOWNLOAD_ENABLED gate — the
// onboarding's line «설정에서 «데스크톱 앱 받기»로 다시 열 수 있어요» must be true where the flag is off. Harness as page.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams('tab=desktop'),
  usePathname: () => '/settings',
}));

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: false, json: async () => ({ data: null }) })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  delete process.env.DESKTOP_DOWNLOAD_ENABLED; // the flag off — the tab is there anyway
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

describe('[SID:4668] SettingsPage — «데스크톱 앱 받기» tab', () => {
  it('T10 the tab is listed under my account with the onboarding\'s words, and ?tab=desktop shows the download card without the flag', async () => {
    const { default: SettingsPage } = await import('./page');
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SettingsPage /></NextIntlClientProvider>);
    });
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });

    const tabNames = Array.from(container.querySelectorAll('[role="tab"]')).map((el) => el.textContent?.trim());
    // reverted (no trigger) → this fails
    expect(tabNames).toContain(koMessages.settings.desktopTab);
    // the onboarding's way out names this tab (story 4715: its old «데스크톱 앱 받기» h1 is gone — the line that points here is the link)
    expect(koMessages.onboarding.download.laterNote).toContain(`«${koMessages.settings.desktopTab}»`);
    expect(container.querySelector('[data-testid=settings-desktop-tab]')).not.toBeNull();
    expect(container.querySelector('[data-testid=desktop-download-card]')).not.toBeNull();
  });
});
