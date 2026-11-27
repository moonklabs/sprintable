// @vitest-environment jsdom
//
// story 5031 (C1 step 5a · PO 11-27) — from lg the top bar's path ends with the ROOM's name («조직 › 채팅 › 방 이름»). The page publishes it through the shell's title slot as a plain span: the room head under the bar still draws the page's one h1 (until step 5b),
// so the bar's copy must not be a heading. Below lg the slot carries the phone's own room bar (that part is page.4887-head-menu / page.test).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/chats/conv-1',
  useParams: () => ({ conversation_id: 'conv-1' }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/chat/chat-view', () => ({ ChatView: () => <div data-testid="chat-view-stub" /> }));
vi.mock('@/hooks/use-synthetic-parent-tab-history', () => ({ useSyntheticParentTabHistory: () => {} }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1', projectMemberships: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/api/conversations/conv-1')
    ? { ok: true, json: async () => ({ title: '점심 모임', type: 'group', muted: false, last_read_at: null, free_response: false, project_id: 'proj-1', is_project_channel: false, participants: [{ member_id: 'me-1', name: '나', avatar_url: null, type: 'human' }, { member_id: 'them-1', name: '유나', avatar_url: null, type: 'human' }] }) }
    : { ok: true, json: async () => ({ data: [] }) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(belowLg: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: belowLg, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const { default: ConversationPage } = await import('./page');
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  const { ToastProvider } = await import('@/components/ui/toast');
  /** what the shell's bar would draw: the title slot's node, in a box of its own */
  function BarProbe() { return <div data-testid="bar-title">{useTopBar().title}</div>; }
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><TopBarProvider><BarProbe /><ConversationPage /></TopBarProvider></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}
const bar = () => container.querySelector('[data-testid="bar-title"]') as HTMLElement;

describe('[SID:5031] ConversationPage — the room\'s name in the top bar from lg', () => {
  it('⭐from lg the bar\'s title is the room\'s name as a plain span — not a heading — and the page keeps its one h1 (the room head\'s)', async () => {
    await mount(false);
    expect(bar().textContent).toBe('점심 모임');
    expect(bar().firstElementChild!.tagName).toBe('SPAN');
    expect(bar().querySelector('h1, h2, [role="heading"]')).toBeNull();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('below lg the bar carries the phone\'s own room bar (back · name · people), not the lg span', async () => {
    await mount(true);
    expect(bar().querySelector('[data-testid="room-bar"]')).not.toBeNull();
  });
});

// ───────────────────────── codex round 1 (5a): real bar · width unknown · the 1023 / 1024 boundary ─────────────────────────
/** a matchMedia that follows a window width the way a browser's does (min-/max-width queries, `change` events) — so the REAL components switch between phone and desktop shapes */
function emulateWidth(initial: number) {
  const listeners = new Set<() => void>();
  const state = { width: initial };
  const matches = (q: string) => {
    const max = /max-width:\s*(\d+)px/.exec(q)?.[1];
    const min = /min-width:\s*(\d+)px/.exec(q)?.[1];
    return (max === undefined || state.width <= Number(max)) && (min === undefined || state.width >= Number(min));
  };
  vi.stubGlobal('matchMedia', (q: string) => ({ get matches() { return matches(q); }, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) }));
  vi.stubGlobal('innerWidth', initial);
  return { setWidth: async (w: number) => { state.width = w; vi.stubGlobal('innerWidth', w); await act(async () => { for (const l of [...listeners]) l(); }); } };
}

async function mountWithBar() {
  const { default: ConversationPage } = await import('./page');
  const { TopBar } = await import('@/components/nav/top-bar');
  const { TopBarProvider } = await import('@/components/nav/top-bar-context');
  const { SidebarProvider } = await import('@/components/ui/sidebar');
  const { ToastProvider } = await import('@/components/ui/toast');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ToastProvider><TopBarProvider pathname="/chats/conv-1"><SidebarProvider>
          <TopBar orgId="o1" orgMemberships={[{ orgId: 'o1', orgName: '올리베이라 조직', orgSlug: 'acme' }]} projectId="proj-1" projectMemberships={[{ projectId: 'proj-1', projectName: '스프린터블' }]} />
          <ConversationPage />
        </SidebarProvider></TopBarProvider></ToastProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}
const pathItems = () => [...container.querySelectorAll('[data-testid="top-bar-path"] li')].map((li) => li.textContent!.trim()).filter(Boolean);

describe('[SID:5031] ConversationPage — the REAL publisher under the REAL bar', () => {
  it('⭐the path reads «조직 › 채팅 › 방 이름» — once each, the room as the last item (aria-current), a span in it', async () => {
    emulateWidth(1280);
    await mountWithBar();
    expect(pathItems()).toEqual(['올리베이라 조직', '채팅', '점심 모임']);
    const last = container.querySelector('[data-testid="top-bar-title"]')!;
    expect(last.getAttribute('aria-current')).toBe('page');
    expect(last.firstElementChild!.tagName).toBe('SPAN');
  });

  it('⭐the 1024 / 1023 boundary: at 1024 the bar carries the room\'s name (desktop shape); at 1023 the phone room bar replaces it (and the tablet\'s menu door appears) — and back at 1024; the real components switch, the shell is not mounted', async () => {
    const win = emulateWidth(1024);
    await mountWithBar();
    expect(container.querySelector('[data-testid="top-bar-title"] > span')!.textContent).toBe('점심 모임');
    expect(container.querySelector('[data-testid="room-bar"]')).toBeNull();
    expect(container.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
    await win.setWidth(1023);
    expect(container.querySelector('[data-testid="top-bar-title"] [data-testid="room-bar"]'), 'the phone\'s room bar is the bar\'s title').not.toBeNull();
    expect(container.querySelector('[data-testid="top-bar-title"] > span.text-sm')).toBeNull();
    expect(container.querySelector('[data-slot="sidebar-trigger"]'), '768–1023: the tablet\'s menu door').not.toBeNull();
    await win.setWidth(1024);
    expect(container.querySelector('[data-testid="top-bar-title"] > span')!.textContent).toBe('점심 모임');
    expect(container.querySelector('[data-slot="sidebar-trigger"]')).toBeNull();
  });

  it('a phone width (390): the phone room bar, never the desktop span (and no tablet door)', async () => {
    emulateWidth(390);
    await mountWithBar();
    expect(container.querySelector('[data-testid="top-bar-title"] [data-testid="room-bar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="top-bar-title"] > span.text-sm')).toBeNull();
  });
});
