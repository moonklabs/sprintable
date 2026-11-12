// @vitest-environment jsdom
//
// story 4887 — deleting the ORIGINAL message from inside its thread: the room's list holds that message, so the room hands ThreadPanel its own delete handler (the same tombstone the room uses for its own rows).
// The real ChatView, ChatBubble and ThreadPanel on a fed message list; the panel's own replies are pinned in thread-panel.4887-menu.test.tsx.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CHAT_MESSAGE_DELETED_EVENT, forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/chats/thread-1' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { forgetKnownDeletedForTests(); await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.resetModules(); });


const mine = { id: 'm1', memo_id: 'thread-1', created_by: 'me-1', sender_name: '나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, content: '내 원본 글', attachments: [], created_at: new Date(Date.UTC(2026, 10, 10, 1, 0, 0)).toISOString(), reply_count: 1 };
const fetchMock = vi.fn();

async function mountRoom() {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return { ok: true, status: 200, json: async () => ({ deleted_at: '2026-11-10T02:00:00.000Z' }) };
    if (typeof url === 'string' && url.includes('thread_id=')) return { ok: true, json: async () => ({ data: [] }) };
    if (typeof url === 'string' && url.includes('/messages?')) return { ok: true, json: async () => ({ data: [mine], meta: { next_cursor: null, has_more: false } }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" projectId="proj-1" /></ChatRailProvider></NextIntlClientProvider>);
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('ChatView — the thread\'s original message can be deleted from its menu (story 4887)', () => {
  it('⭐ open the thread, delete the ORIGINAL from its menu: the room sends the DELETE and its own row becomes a tombstone', async () => {
    await mountRoom();
    const replyBtn = container.querySelector('[data-testid="chat-bubble-reply-button"]') as HTMLElement;
    await act(async () => { replyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const original = container.querySelector('[data-testid="thread-original"] .group\\/bubble') as HTMLElement;
    expect(original, 'the thread is open with its original').not.toBeNull();
    await act(async () => { original.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    const del = [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes(koMessages.common.delete)) as HTMLElement;
    await act(async () => { del.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const sent = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    expect(heard, 'the room announces the delete so its LIST blanks the preview').toEqual([{ conversationId: 'thread-1', createdAt: mine.created_at, messageId: 'm1', threadId: null, deletedAt: '2026-11-10T02:00:00.000Z' }]); // story 4903 (codex on 5664): with the message's id, so the list matches by it and remembers it // reverted (nothing announced) → []
    expect(String(sent?.[0])).toBe('/api/conversations/thread-1/messages/m1'); // reverted (the panel is not handed the room's handler) → no DELETE at all
    const roomRow = container.querySelector('.group\\/bubble') as HTMLElement; // the first row of the ROOM's list
    expect(roomRow.textContent).toContain(koMessages.chats.deletedMessagePlaceholder);
    // and the OPEN thread's own copy of that original is a tombstone too — it must not keep showing the text of a message that is gone
    const threadOriginal = container.querySelector('[data-testid="thread-original"]') as HTMLElement;
    expect(threadOriginal.textContent).toContain(koMessages.chats.deletedMessagePlaceholder); // reverted (only the room's list is updated) → the old text stays
    expect(threadOriginal.textContent).not.toContain('내 원본 글');
  });
});
