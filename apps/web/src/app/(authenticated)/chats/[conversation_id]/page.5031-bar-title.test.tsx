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
