// @vitest-environment jsdom
//
// story #4413 — 폰(1024 미만 · 사이드바가 닫힌 시트)에서 전역 검색(명령 팔레트)을 여는 길이 0이었다: 열림 상태와 팔레트가 사이드바 안에만
// 있었고, 닫힌 시트는 안쪽을 그리지 않는다. 이제 상태는 셸 층 한 벌(CommandPaletteProvider)이고 팔레트는 Sidebar 밖에 그린다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommandPaletteProvider, useCommandPalette, useCommandPaletteOpener } from './command-palette-context';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 390, writable: true, configurable: true });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function Opener() {
  const open = useCommandPaletteOpener();
  return <button type="button" data-testid="probe-open" onClick={() => open?.()}>open</button>;
}

function OpenProbe() {
  const { open } = useCommandPalette();
  return <span data-testid="probe-state">{open ? 'open' : 'closed'}</span>;
}

const paletteInput = () => document.querySelector(`input[placeholder="${koMessages.commandPalette?.placeholder ?? ''}"]`) ?? document.querySelector('[data-modal-popup] input');

describe('폰 폭 — 전역 검색 팔레트(story #4413)', () => {
  it('⭐사이드바가 닫힌 시트여도 셸 상태로 팔레트가 열린다(팔레트가 Sidebar 밖)', async () => {
    const { AppSidebar } = await import('@/components/nav/app-sidebar');
    const { SidebarProvider } = await import('@/components/ui/sidebar');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <CommandPaletteProvider>
            <SidebarProvider>
              <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />
            </SidebarProvider>
            <Opener />
          </CommandPaletteProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); });
    expect(paletteInput()).toBeNull();
    await act(async () => { (container.querySelector('[data-testid="probe-open"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(paletteInput()).not.toBeNull();
  });

  it('⭐«전체»(/more) 맨 위 검색 행 — 누르면 셸 팔레트 상태가 열린다 · 공급자 밖이면 행을 안 그린다', async () => {
    vi.doMock('@/hooks/use-mobile', () => ({ useIsMobile: () => true, MOBILE_BREAKPOINT: 1024 }));
    const { default: MorePage } = await import('@/app/(authenticated)/more/page');
    const { TopBarProvider } = await import('@/components/nav/top-bar-context');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider>
            <CommandPaletteProvider>
              <MorePage />
              <OpenProbe />
            </CommandPaletteProvider>
          </TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    const row = container.querySelector('[data-testid="more-global-search"]') as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(koMessages.nav.search);
    expect(container.querySelector('[data-testid="probe-state"]')!.textContent).toBe('closed');
    await act(async () => { row!.click(); });
    expect(container.querySelector('[data-testid="probe-state"]')!.textContent).toBe('open');

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TopBarProvider><MorePage /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    expect(container.querySelector('[data-testid="more-global-search"]')).toBeNull();
  });
});
