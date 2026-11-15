// @vitest-environment jsdom
//
// story 4903 AC3 — ANOTHER person deletes a message of the room this screen has open: the server's frame reaches the room as the local «message deleted» announcement (with the message's
// id) and the row turns into the tombstone at once — and so does the open thread's COPY of its original. The real ChatView and ChatBubble on a fed message list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { announceChatMessageDeleted, forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/chats/thread-1' }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
// the fake stream: the real hook subscribes to it and the test plays a server frame through it
const stream = vi.hoisted(() => ({ handlers: new Map<string, (raw: string) => void>() }));
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ subscribe: (name: string, h: (raw: string) => void) => { stream.handlers.set(name, h); return () => { stream.handlers.delete(name); }; }, isAlive: () => true, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));
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
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); forgetKnownDeletedForTests(); vi.resetModules(); });

const mine = { id: 'm1', memo_id: 'thread-1', created_by: 'me-1', sender_name: '나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, content: '내 원본 글', attachments: [], created_at: new Date(Date.UTC(2026, 10, 10, 1, 0, 0)).toISOString(), reply_count: 1 };
const theirs = { id: 'm2', memo_id: 'thread-1', created_by: 'other-1', sender_name: '유나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, content: '남의 글 — 곧 지워질 글', attachments: [], created_at: new Date(Date.UTC(2026, 10, 10, 1, 5, 0)).toISOString(), reply_count: 0 };

async function mountRoom() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('thread_id=')) return { ok: true, json: async () => ({ data: [] }) };
    if (typeof url === 'string' && url.includes('/messages?')) return { ok: true, json: async () => ({ data: [mine, theirs], meta: { next_cursor: null, has_more: false } }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" projectId="proj-1" /></ChatRailProvider></NextIntlClientProvider>);
  });
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
}
const rowOf = (text: string) => [...container.querySelectorAll('.group\\/bubble')].find((e) => e.textContent?.includes(text)) as HTMLElement | undefined;
const frame = (o: Partial<{ conversationId: string; messageId: string | undefined }>) => announceChatMessageDeleted({
  conversationId: o.conversationId ?? 'thread-1', createdAt: theirs.created_at, ...('messageId' in o ? { messageId: o.messageId } : { messageId: 'm2' }), threadId: null, deletedAt: '2026-11-12T01:05:00.000Z',
});


// the first page of messages is a fetch the test releases by hand (a fetch already IN FLIGHT when the frame arrives)
async function mountRoomWithPendingFetch() {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('thread_id=')) return { ok: true, json: async () => ({ data: [] }) };
    if (typeof url === 'string' && url.includes('/messages?')) { await gate; return { ok: true, json: async () => ({ data: [mine, theirs], meta: { next_cursor: null, has_more: false } }) }; }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }));
  const { ChatView } = await import('./chat-view');
  const { ChatRailProvider } = await import('../../app/(authenticated)/chats/chat-rail-context');
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatRailProvider><ChatView threadId="thread-1" currentTeamMemberId="me-1" projectId="proj-1" /></ChatRailProvider></NextIntlClientProvider>);
  });
  return { release: async () => { release(); for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); }); } };
}

describe('ChatView — a delete that arrives while a fetch is in flight, and the real hook feeding the room (story 4903 AC3)', () => {
  it('⭐ the frame arrives BEFORE the first page of messages resolves: the late response must not bring the text back', async () => {
    const room = await mountRoomWithPendingFetch();
    const lib = await import('@/lib/chat-message-deleted');
    await act(async () => { lib.announceChatMessageDeleted({ conversationId: 'thread-1', createdAt: theirs.created_at, messageId: 'm2', threadId: null, deletedAt: '2026-11-12T01:05:00.000Z' }); });
    await room.release();
    expect(container.textContent).not.toContain('남의 글 — 곧 지워질 글'); // reverted (the room only tombstones what it already holds) → the late response puts the words on screen
    expect(container.textContent).toContain(koMessages.chats.deletedMessagePlaceholder);
    expect(container.textContent).toContain('내 원본 글');
    lib.forgetKnownDeletedForTests();
  });

  it('⭐ the REAL hook through a fake stream: a server frame (a string, as the stream delivers it) turns the open room\'s message into a tombstone', async () => {
    await mountRoom();
    const { useChatMessageDeletedSse } = await import('@/hooks/use-chat-message-deleted-sse');
    function Probe() { useChatMessageDeletedSse(); return null; }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const hostRoot = createRoot(host);
    await act(async () => { hostRoot.render(<Probe />); });
    expect([...stream.handlers.keys()]).toContain('conversation.message_deleted');
    const frameJson = JSON.stringify({ event_type: 'conversation.message_deleted', conversation_id: 'thread-1', id: 'm2', thread_id: null, created_at: theirs.created_at, deleted_at: '2026-11-12T01:05:00.000Z', recipient_id: 'me-1', event_id: 'e-1' });
    await act(async () => { stream.handlers.get('conversation.message_deleted')!(frameJson); });
    expect(container.textContent).not.toContain('남의 글 — 곧 지워질 글'); // reverted (the hook announces nothing) → the words stay
    expect(container.textContent).toContain(koMessages.chats.deletedMessagePlaceholder);
    await act(async () => { hostRoot.unmount(); });
    host.remove();
    (await import('@/lib/chat-message-deleted')).forgetKnownDeletedForTests();
  });
});

describe('ChatView — a message another person deleted turns into a tombstone without a reload (story 4903 AC3)', () => {
  it('⭐ the frame for this room turns THAT message into the tombstone; the other messages are untouched', async () => {
    await mountRoom();
    expect(rowOf('남의 글 — 곧 지워질 글'), 'the message is on screen before the delete').not.toBeUndefined();
    await act(async () => { frame({}); });
    expect(container.textContent).not.toContain('남의 글 — 곧 지워질 글'); // reverted (the room does not listen) → the words stay
    const gone = [...container.querySelectorAll('.group\\/bubble')].filter((e) => e.textContent?.includes(koMessages.chats.deletedMessagePlaceholder));
    expect(gone, 'exactly one tombstone').toHaveLength(1);
    expect(rowOf('내 원본 글'), 'the other message keeps its words').not.toBeUndefined();
  });

  it('a frame for ANOTHER room · or one without a message id (a delete made on this very screen announces none) changes nothing', async () => {
    await mountRoom();
    await act(async () => { frame({ conversationId: 'other-room' }); frame({ messageId: undefined }); });
    expect(container.textContent).toContain('남의 글 — 곧 지워질 글'); // reverted (matches any room) → the words go
    expect(container.textContent).not.toContain(koMessages.chats.deletedMessagePlaceholder);
  });

  it('⭐ the OPEN thread\'s copy of its original is a tombstone too — the panel must not keep showing the text of a message that is gone', async () => {
    await mountRoom();
    const replyBtn = container.querySelector('[data-testid="chat-bubble-reply-button"]') as HTMLElement; // the first row: m1, the thread's original
    await act(async () => { replyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    const original = container.querySelector('[data-testid="thread-original"]') as HTMLElement;
    expect(original.textContent).toContain('내 원본 글');
    await act(async () => { announceChatMessageDeleted({ conversationId: 'thread-1', createdAt: mine.created_at, messageId: 'm1', threadId: null, deletedAt: '2026-11-12T01:05:00.000Z' }); });
    expect((container.querySelector('[data-testid="thread-original"]') as HTMLElement).textContent).toContain(koMessages.chats.deletedMessagePlaceholder); // reverted (only the room's list) → the old text stays
    expect((container.querySelector('[data-testid="thread-original"]') as HTMLElement).textContent).not.toContain('내 원본 글');
  });
});
