// @vitest-environment jsdom
//
// story 4887 — the list's one-line preview of a room's latest message kept showing the text of a message DELETED on this screen until the next refetch (the server scrubs it then: content «» · no attachment flag).
// The room and its thread announce a delete (lib/chat-message-deleted); the list blanks the matching latest message at once. The list's record has no message id, so the match is by room + the instant it was sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';
import { announceChatMessageDeleted, sameInstant } from '@/lib/chat-message-deleted';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/hooks/use-chat-sse', () => ({ useChatSse: () => ({ connected: true, polling: false }) }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member' }); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });


const T = '2026-10-13T09:00:00Z';
const conv = (id: string, content: string, createdAt: string) => ({
  id, type: 'group', title: `방 ${id}`, latest_message: { content, created_at: createdAt, has_attachments: true }, updated_at: createdAt, unread_count: 0, participants: [],
});

async function mount(convs: object[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: convs, total: convs.length }) };
    return { ok: false, status: 404, json: async () => null };
  }));
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatListView projectId="proj-current" currentTeamMemberId="me-1" /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const rowOf = (title: string) => [...container.querySelectorAll('[data-testid="chat-list-rooms"] button')].find((b) => b.textContent?.includes(title)) as HTMLElement;

describe('[SID:4887] ChatListView — a deleted latest message does not stay in the list preview', () => {
  it('⭐ the room whose LATEST message was deleted shows «메시지 없음» at once (as the server\'s refetch would) — another room, and an older message of the same room, keep their text', async () => {
    await mount([conv('c1', '지운 글 본문', T), conv('c2', '다른 방 글', T), conv('c3', '이 방의 최신 글', '2026-10-13T10:00:00Z')]);
    expect(rowOf('방 c1').textContent).toContain('지운 글 본문');
    // the same instant spelled the other way (+00:00, fractional digits) — the room sent it that way
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: '2026-10-13T09:00:00.000+00:00' }); });
    expect(rowOf('방 c1').textContent).not.toContain('지운 글 본문'); // reverted (the list never hears it) → the deleted text stays
    expect(rowOf('방 c1').textContent).toContain(koMessages.chats.noMessages);
    expect(rowOf('방 c2').textContent).toContain('다른 방 글'); // the same instant in ANOTHER room is not this message
    // an older message of c3 (not its latest) was deleted: its preview is the newer one and does not change
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c3', createdAt: T }); });
    expect(rowOf('방 c3').textContent).toContain('이 방의 최신 글');
  });

  it('the instant comparison is by time, not by spelling — and an unreadable time never matches', () => {
    expect(sameInstant('2026-10-13T09:00:00Z', '2026-10-13T09:00:00.000+00:00')).toBe(true);
    expect(sameInstant('2026-10-13T09:00:00Z', '2026-10-13T09:00:01Z')).toBe(false);
    expect(sameInstant('nope', 'nope')).toBe(false);
    expect(sameInstant(null, T)).toBe(false);
  });
});
