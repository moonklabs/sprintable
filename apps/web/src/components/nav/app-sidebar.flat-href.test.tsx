// @vitest-environment jsdom
// story #4226 — 사이드바의 flat(static) 링크는 useFlatHref(`?p=`)를 거친다. resource 항목은 경로가 프로젝트. story 5031: 목록 칸은 지금 자리의 줄만 그리므로 자리마다 한 번씩 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/org-briefing' } }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => `${h}${h.includes('?') ? '&' : '?'}p=P` }));

const { AppSidebar } = await import('./app-sidebar');
const { SidebarProvider } = await import('@/components/ui/sidebar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { inboxUnreadCount: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('AppSidebar — flat 링크 `?p=`(story #4226)', () => {
  it.each([
    ['/org-briefing', '/org-briefing?p=P', '/org-briefing'],
    ['/chats', '/chats?p=P', '/chats'],
    ['/settings', '/settings?p=P', '/settings'],
  ])('⭐%s 자리의 static 줄은 `?p=`를 싣는다(첫 화면 %s)', async (path, withP, bare) => {
    pathnameRef.current = path;
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SidebarProvider>
        <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />
      </SidebarProvider></NextIntlClientProvider>);
    });
    const hrefs = [...container.querySelectorAll('[data-nav-id] ')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain(withP);
    expect(hrefs).not.toContain(bare);
  });
});
