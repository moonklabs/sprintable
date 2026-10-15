// @vitest-environment jsdom
//
// story #4442 (Qadir's delta · PO 00:04Z) — the legacy chat: a DM send whose answer is `forked` (the DM became a new group)
// navigated away and returned before telling this tab's lists about the message. Its nonce was already remembered, so the
// server's echo was dropped here too — the list had no row for the new group until a reload. The real list and the real
// chat view in one tree, with the real `useChatSse` (EventSource stubbed): after a forked send, the list reads again and
// the new group's row is on top; the old DM's view does not get the message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => '/chats/dm-1',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ role: 'member' }) }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => null,
  useSseConnectedContext: () => true,
}));
vi.mock('./chat-input', () => ({
  ChatInput: ({ onSend }: { onSend: (content: string) => Promise<void> | void }) => (
    <button type="button" data-testid="mock-send" onClick={() => { void onSend('그룹으로 갈라지는 말'); }}>send</button>
  ),
}));

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {}
  addEventListener() { /* noop */ }
  removeEventListener() { /* noop */ }
  close() { /* noop */ }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const ME = 'me-1';
const row = (id: string, title: string, content: string, at: string) => ({
  id, type: 'group', title, participants: [], unread_count: 0, latest_message: { content, created_at: at }, updated_at: at, created_at: at,
});

beforeEach(() => {
  pushMock.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('legacy chat — a forked send reaches this tab\'s list (#4442)', () => {
  it('the new group\'s row comes up top; the old DM view does not get the message', async () => {
    let rows: unknown[] = [row('dm-1', '하윤과 나', '먼저 온 말', '2026-10-01T00:10:00Z')];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/dm-1/messages')) {
        rows = [row('group-new', '새 그룹방', '그룹으로 갈라지는 말', '2026-10-01T00:20:00Z'), ...rows];
        return { ok: true, json: async () => ({
          forked: true, forked_conversation_id: 'group-new',
          data: { id: 'm-fork', conversation_id: 'group-new', content: '그룹으로 갈라지는 말', attachments: [], created_at: '2026-10-01T00:20:00Z', sender: { id: ME, name: '나', type: 'human' } },
        }) };
      }
      if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: rows, total: rows.length }) };
      if (url.includes('/messages?')) return { ok: true, json: async () => ({ data: [], meta: { next_cursor: null, has_more: false } }) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    const { ChatListView } = await import('./chat-list-view');
    const { ChatView } = await import('./chat-view');
    const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ChatRailProvider>
            <ChatListView projectId="proj-1" currentTeamMemberId={ME} />
            <ChatView threadId="dm-1" currentTeamMemberId={ME} />
          </ChatRailProvider>
        </NextIntlClientProvider>,
      );
    });
    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    await act(async () => { (container.querySelector('[data-testid="mock-send"]') as HTMLElement).click(); });
    for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

    expect(pushMock).toHaveBeenCalledWith('/chats/group-new');
    const titles = [...container.querySelectorAll('button, a, li')].map((el) => el.textContent ?? '').filter((t) => /새 그룹방|하윤과 나/.test(t));
    expect(titles[0]).toContain('새 그룹방');
    expect(titles[0]).toContain('그룹으로 갈라지는 말');
    // the old DM's view never shows the message (it belongs to the new group)
    expect(container.querySelector('#msg-m-fork')).toBeNull();
    expect([...container.querySelectorAll('[data-testid="chat-bubble-text"]')].map((e) => e.textContent)).not.toContain('그룹으로 갈라지는 말');
  });
});
