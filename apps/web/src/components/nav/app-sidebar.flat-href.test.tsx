// @vitest-environment jsdom
// story #4226 — 사이드바의 flat(static) 링크(대화 카드 · static 항목)는 useFlatHref(`?p=`)를 거친다. resource 항목은 경로가 프로젝트.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
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
  it('⭐대화 카드(/chats)와 static 항목(/org-briefing · /organization/insights-board)은 `?p=`를 싣는다', async () => {
    await act(async () => {
      root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><SidebarProvider>
        <AppSidebar projectMemberships={[]} chatUnreadTotal={0} />
      </SidebarProvider></NextIntlClientProvider>);
    });
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/chats?p=P');
    expect(hrefs).toContain('/org-briefing?p=P');
    expect(hrefs).toContain('/organization/insights-board?p=P');
    expect(hrefs).not.toContain('/chats');
    expect(hrefs).not.toContain('/org-briefing');
  });
});
