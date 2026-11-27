// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · codex round 1) — the settings PAGE (the real publisher) under the REAL bar: «조직 › 설정 › 지금 칸», once each — and the unknown-width load does not publish.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, params, width } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), params: { current: new URLSearchParams('') }, width: { current: 'lg-up' as 'unknown' | 'below-lg' | 'lg-up' } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => params.current,
  usePathname: () => '/settings',
}));
vi.mock('@/hooks/use-mobile', async (orig) => ({ ...(await orig<typeof import('@/hooks/use-mobile')>()), useWidthClass: () => width.current }));
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

async function draw(query: string, w: 'unknown' | 'below-lg' | 'lg-up') {
  params.current = new URLSearchParams(query);
  width.current = w;
  const { default: SettingsPage } = await import('./page');
  const { TopBar } = await import('@/components/nav/top-bar');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { PhoneBridgeContext } = await import('@/components/providers/phone-bridge-context');
  await act(async () => {
    root.render(
      <PhoneBridgeContext.Provider value={{ inPhoneApp: false, phoneCall: vi.fn() }}>
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider pathname="/settings"><SidebarProvider>
            <TopBar orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }]} projectMemberships={[]} />
            <SettingsPage />
          </SidebarProvider></TopBarProvider>
        </NextIntlClientProvider>
      </PhoneBridgeContext.Provider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
  return [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim()).filter(Boolean);
}

describe('SettingsPage under the real bar (story 5031 · 5a)', () => {
  it('⭐tab=appearance → «올리베이라 조직 › 설정 › 화면» (each name once; the page\'s own h1 «설정» is the nav column\'s, not the bar\'s)', async () => {
    expect(await draw('tab=appearance', 'lg-up')).toEqual(['올리베이라 조직', '설정', koMessages.settings.tabDisplay]);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });
  it('the first tab reads once too (no «설정 › 설정»)', async () => {
    const items = await draw('', 'lg-up');
    expect(items.slice(0, 2)).toEqual(['올리베이라 조직', '설정']);
    for (let i = 1; i < items.length; i++) expect(items[i]).not.toBe(items[i - 1]);
  });
  it('⭐an unknown width publishes nothing (the title item is empty: the path stays «조직 › 설정»)', async () => {
    expect(await draw('tab=appearance', 'unknown')).toEqual(['올리베이라 조직', '설정']);
  });
});
