// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · PO 11-27) — /settings has the same top bar as every screen; from lg the bar's last crumb is the CURRENT TAB's name (path «조직 › 설정 › 지금 칸»), published through the shell's title slot as a plain span
// (the nav column's «설정» stays the page's only h1). A phone keeps the list / the back row's own name — the bar's title stays empty there (one name, not two).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, params, slot } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), params: { current: new URLSearchParams('') }, slot: { titles: [] as Array<{ tag: string; text: string }> } }));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title }: { title: React.ReactElement<{ children: string }> }) => { slot.titles.push({ tag: String(title.type), text: String(title.props.children) }); return null; },
}));
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
  slot.titles = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ data: null }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function draw(query: string, belowLg: boolean) {
  params.current = new URLSearchParams(query);
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: belowLg, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
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

describe('SettingsPage — the top bar title from lg (story 5031 · 5a)', () => {
  it('⭐from lg the current tab\'s name goes to the bar as a plain span — «화면» for ?tab=appearance — and the page keeps its ONE h1 (the nav column\'s)', async () => {
    await draw('tab=appearance', false);
    expect(slot.titles.at(-1)).toEqual({ tag: 'span', text: koMessages.settings.tabDisplay });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('h1')!.textContent).toBe(koMessages.settings.title);
  });

  it('a different tab publishes its own name (the bar follows the tab)', async () => {
    await draw('tab=profile', false);
    const first = slot.titles.at(-1)!.text;
    await draw('tab=appearance', false);
    expect(first).not.toBe(slot.titles.at(-1)!.text);
  });

  it('below lg nothing is published: the phone keeps the list / back row\'s name (the bar\'s title stays empty)', async () => {
    await draw('tab=appearance', true);
    expect(slot.titles).toEqual([]);
  });
});
