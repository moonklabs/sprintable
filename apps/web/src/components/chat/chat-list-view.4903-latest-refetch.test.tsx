// @vitest-environment jsdom
//
// story 4903 (QA lens ⑥) — «지운 뒤 = 남은 가장 새 글»: a room's latest message is deleted → its row says «메시지 없음» at once, then the list asks the server again and shows the newest message that is still there
// (the server skips the deleted one and sends the message's `id` since 5653). The match is by the message id when both sides have one — two messages of one microsecond are told apart — else by the moment.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';
import { announceChatMessageDeleted, blankKnownDeletedPreviews, forgetKnownDeletedForTests, isDeletedLatest } from '@/lib/chat-message-deleted';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams('') }));
// the list's own message callback is kept so a test can play «a new message arrives» through it
const sse = vi.hoisted(() => ({ opts: null as null | { onConversationMessage?: (payload: Record<string, unknown>) => void } }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: (opts: { onConversationMessage?: (payload: Record<string, unknown>) => void }) => { sse.opts = opts; return { connected: true, polling: false }; } };
});
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  forgetKnownDeletedForTests();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', orgMemberships: [], currentMemberType: 'human' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); forgetKnownDeletedForTests(); });

const T_OLD = '2026-11-12T01:00:00.000001+00:00';
const T_MID = '2026-11-12T01:00:03.000001+00:00';
const T_NEW = '2026-11-12T01:00:05.000002+00:00';
const T_NEWER = '2026-11-12T01:00:08.000003+00:00';
const row = (id: string, latest: { id?: string; content: string; created_at: string } | null) => ({
  id, type: 'group', title: `방 ${id}`, latest_message: latest, updated_at: latest?.created_at ?? T_OLD, unread_count: 0, participants: [],
});
const rowOf = (title: string) => [...container.querySelectorAll('[data-testid="chat-list-rooms"] button')].find((b) => b.textContent?.includes(title)) as HTMLElement;
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };

/** the list endpoint answers from a queue (the last answer repeats); every call to it is counted, and the Nth answer can be held back */
function stubList(answers: object[][], hold?: { call: number; gate: Promise<void> }, extra?: { holds?: Array<{ call: number; gate: Promise<void> }>; fail?: number[] }) {
  let calls = 0;
  const holds = new Map<number, Promise<void>>();
  if (hold) holds.set(hold.call, hold.gate);
  for (const h of extra?.holds ?? []) holds.set(h.call, h.gate);
  const failSet = new Set(extra?.fail ?? []);
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) {
      calls += 1;
      const gate = holds.get(calls);
      if (gate) await gate;
      if (failSet.has(calls)) return { ok: false, status: 500, json: async () => null };
      const data = answers[Math.min(calls - 1, answers.length - 1)]!;
      return { ok: true, json: async () => ({ data, total: data.length }) };
    }
    return { ok: false, status: 404, json: async () => null };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { listCalls: () => calls };
}
async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ChatListView projectId="proj-current" currentTeamMemberId="me-1" /></NextIntlClientProvider>); });
  await flush();
}

describe('[SID:4903] ChatListView — after the latest message is deleted the preview is the newest one that is still there', () => {
  it('⭐ the row blanks at once, then the refetch brings the remaining newest message (not «메시지 없음»)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = stubList(
      [[row('c1', { id: 'm-new', content: '지울 최신 글', created_at: T_NEW })], [row('c1', { id: 'm-old', content: '먼저 보낸 글', created_at: T_OLD })]],
      { call: 2, gate },
    );
    await mount();
    expect(rowOf('방 c1').textContent).toContain('지울 최신 글');
    expect(list.listCalls()).toBe(1);
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-new', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    expect(rowOf('방 c1').textContent).toContain(koMessages.chats.noMessages); // at once, before the server answers
    expect(list.listCalls()).toBe(2); // reverted (no refetch) → 1
    release(); await flush();
    expect(rowOf('방 c1').textContent).toContain('먼저 보낸 글'); // reverted (no refetch) → the row stays «메시지 없음»
    expect(rowOf('방 c1').textContent).not.toContain('지울 최신 글');
  });

  it('a delete of a message that is NOT the room\'s latest changes nothing and asks the server nothing', async () => {
    const list = stubList([[row('c1', { id: 'm-new', content: '최신 글', created_at: T_NEW })]]);
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_OLD, messageId: 'm-old', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    expect(rowOf('방 c1').textContent).toContain('최신 글');
    expect(list.listCalls()).toBe(1); // reverted (refetch on every delete) → 2
  });

  it('⭐ two messages of the SAME microsecond: the id decides — deleting the other one leaves the preview alone', async () => {
    const list = stubList([[row('c1', { id: 'm-b', content: '살아 있는 글', created_at: T_NEW })]]);
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-a', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    expect(rowOf('방 c1').textContent).toContain('살아 있는 글'); // reverted (match by the moment alone) → blanked: the wrong message
    expect(list.listCalls()).toBe(1);
  });

  it('a row without an id (an older server) and a delete made on this very screen (no message id) still match by the moment — and refetch', async () => {
    const list = stubList([[row('c1', { content: '지울 글', created_at: T_NEW })], [row('c1', { content: '남은 글', created_at: T_OLD })]]);
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: '2026-11-12T01:00:05.000002Z' }); }); // the room's own delete: only the moment
    await flush();
    expect(list.listCalls()).toBe(2);
    expect(rowOf('방 c1').textContent).toContain('남은 글');
  });

  it('a delete in ANOTHER room asks nothing', async () => {
    const list = stubList([[row('c1', { id: 'm-new', content: '최신 글', created_at: T_NEW })]]);
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'other-room', createdAt: T_NEW, messageId: 'm-new', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    expect(rowOf('방 c1').textContent).toContain('최신 글');
    expect(list.listCalls()).toBe(1);
  });
});

describe('[SID:4903] ChatListView — deletes and messages that come while the refetch is on its way (codex on 5664)', () => {
  const held = () => { let release: () => void = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release: () => release() }; };

  it('⭐ the NEXT message is deleted before the first refetch has answered: the list asks again, and the newest answer is the one on screen', async () => {
    const h = held();
    const list = stubList(
      [[row('c1', { id: 'm-new', content: '지울 최신 글', created_at: T_NEW })], [row('c1', { id: 'm-mid', content: '곧 지워질 남은 글', created_at: T_MID })], [row('c1', { id: 'm-old', content: '먼저 보낸 글', created_at: T_OLD })]],
      { call: 2, gate: h.gate },
    );
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-new', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); }); // the first ask (held back)
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_MID, messageId: 'm-mid', threadId: null, deletedAt: '2026-11-12T01:05:01Z' }); }); // the survivor is deleted too, while that ask is pending
    expect(list.listCalls()).toBe(3); // reverted (the second delete is not a «hit» while the row still holds the first one) → 2
    h.release(); await flush();
    expect(rowOf('방 c1').textContent).toContain('먼저 보낸 글'); // reverted → the older answer «곧 지워질 남은 글» (a message that is already gone) stays
    expect(rowOf('방 c1').textContent).not.toContain('곧 지워질 남은 글');
  });

  it('⭐ a NEW message arrives while the delete\'s refetch is pending: the list asks once more, so the older answer does not wipe it', async () => {
    const h = held();
    const list = stubList(
      [[row('c1', { id: 'm-new', content: '지울 최신 글', created_at: T_NEW })], [row('c1', { id: 'm-old', content: '먼저 보낸 글', created_at: T_OLD })], [row('c1', { id: 'm-x', content: '그 사이 온 글', created_at: T_NEWER })]],
      { call: 2, gate: h.gate },
    );
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-new', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    await act(async () => { sse.opts!.onConversationMessage!({ conversation_id: 'c1', id: 'm-x', content: '그 사이 온 글', created_at: T_NEWER, sender: { id: 'other' } }); });
    expect(list.listCalls()).toBe(3); // reverted (no ask for the message) → 2
    h.release(); await flush();
    expect(rowOf('방 c1').textContent).toContain('그 사이 온 글'); // reverted → the older answer «먼저 보낸 글» replaces it
  });

  it('a message with NO delete pending does not ask the server (the new ask is for the window only)', async () => {
    const list = stubList([[row('c1', { id: 'm-new', content: '최신 글', created_at: T_NEW })]]);
    await mount();
    await act(async () => { sse.opts!.onConversationMessage!({ conversation_id: 'c1', id: 'm-x', content: '새 글', created_at: T_NEWER, sender: { id: 'other' } }); });
    expect(list.listCalls()).toBe(1);
  });

  it('⭐ a delete made on THIS screen carries the message id: an answer already in flight cannot bring the deleted preview back', async () => {
    const h = held();
    // the held ask started BEFORE the delete: its answer still has the deleted message as the latest
    const list = stubList(
      [[row('c1', { id: 'm-new', content: '지울 최신 글', created_at: T_NEW })], [row('c1', { id: 'm-new', content: '지울 최신 글', created_at: T_NEW })], [row('c1', { id: 'm-old', content: '먼저 보낸 글', created_at: T_OLD })]],
      { call: 2, gate: h.gate },
    );
    await mount();
    await act(async () => { announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-new', threadId: null, deletedAt: '2026-11-12T01:05:00Z' }); });
    h.release(); await flush();
    expect(list.listCalls()).toBeGreaterThanOrEqual(2);
    expect(rowOf('방 c1').textContent).not.toContain('지울 최신 글'); // the remembered id blanks the stale copy (reverted: not remembered → it comes back)
  });
});

describe('[SID:4903] the delete «window» is two generation numbers (PO decision on 5664)', () => {
  const held = () => { let release: () => void = () => {}; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release: () => release() }; };
  const del = (id: string, at: string) => announceChatMessageDeleted({ conversationId: 'c1', createdAt: at, messageId: id, threadId: null, deletedAt: '2026-11-12T01:05:00Z' });
  const newMessage = (id: string) => sse.opts!.onConversationMessage!({ conversation_id: 'c1', id, content: '새 글', created_at: T_NEWER, sender: { id: 'other' } });
  const rows = [[row('c1', { id: 'm-new', content: '최신 글', created_at: T_NEW })]];

  it('⭐ ask A starts → a delete → ask B pushes A aside → A ends LATE (B still pending): the window stays OPEN, so the next event asks again', async () => {
    const a = held(); const b = held();
    const list = stubList([rows[0]!, rows[0]!, rows[0]!, rows[0]!], undefined, { holds: [{ call: 2, gate: a.gate }, { call: 3, gate: b.gate }] });
    await mount();
    await act(async () => { del('m-new', T_NEW); }); // ask A (call 2) — dirty 1
    await act(async () => { del('m-mid', T_MID); }); // the room's next latest is deleted: a «hit» through the open window → ask B (call 3) — dirty 2
    expect(list.listCalls()).toBe(3);
    a.release(); await flush(); // A ends with the generation it held (1): applied 1 < dirty 2
    await act(async () => { newMessage('m-x'); });
    expect(list.listCalls()).toBe(4); // reverted (A\'s end closes the window) → 3: the message would be left to the older answer
    b.release(); await flush();
  });

  it('⭐ the NEWEST ask ends first and the pushed-aside one ends later: the window stays CLOSED (applied is a max, not an assignment) — a message asks nothing', async () => {
    const a = held(); const b = held();
    const list = stubList([rows[0]!, rows[0]!, rows[0]!, rows[0]!], undefined, { holds: [{ call: 2, gate: a.gate }, { call: 3, gate: b.gate }] });
    await mount();
    await act(async () => { del('m-new', T_NEW); });
    await act(async () => { del('m-mid', T_MID); });
    b.release(); await flush(); // B (generation 2) ends: applied 2 = dirty 2 — closed
    a.release(); await flush(); // A (generation 1) ends late: applied stays 2
    await act(async () => { newMessage('m-x'); });
    expect(list.listCalls()).toBe(3); // reverted (assignment) → applied drops to 1, the window re-opens: a message would ask (4)
  });

  it('an ask that ENDS IN FAILURE closes the window by the same line: a message asks nothing', async () => {
    const list = stubList([rows[0]!, rows[0]!, rows[0]!], undefined, { fail: [2] });
    await mount();
    await act(async () => { del('m-new', T_NEW); }); // ask (call 2) fails
    await flush();
    await act(async () => { newMessage('m-x'); });
    expect(list.listCalls()).toBe(2);
  });
});

describe('[SID:4903] isDeletedLatest · blankKnownDeletedPreviews', () => {
  it('by id when both sides have one; by the moment otherwise', () => {
    expect(isDeletedLatest({ id: 'a', created_at: T_NEW }, { messageId: 'a', createdAt: T_OLD })).toBe(true); // the moment is not looked at
    expect(isDeletedLatest({ id: 'a', created_at: T_NEW }, { messageId: 'b', createdAt: T_NEW })).toBe(false); // the same moment is not the same message
    expect(isDeletedLatest({ created_at: T_NEW }, { messageId: 'b', createdAt: '2026-11-12T01:00:05.000002Z' })).toBe(true); // an older server: the moment
    expect(isDeletedLatest({ id: 'a', created_at: T_NEW }, { createdAt: T_NEW })).toBe(true); // this screen's own delete: the moment
    expect(isDeletedLatest({ id: 'a', created_at: T_NEW }, { createdAt: T_OLD })).toBe(false);
  });

  it('a late list response is blanked by the known-deleted id, not by the moment alone', () => {
    announceChatMessageDeleted({ conversationId: 'c1', createdAt: T_NEW, messageId: 'm-gone', threadId: null, deletedAt: '2026-11-12T01:05:00Z' });
    const rows = [row('c1', { id: 'm-gone', content: '지운 글', created_at: T_NEW }), row('c2', { id: 'm-other', content: '같은 순간의 다른 글', created_at: T_NEW })] as never as Array<{ id: string; latest_message: { id?: string; content: string; created_at: string } | null }>;
    const sameMomentOtherMessage = [row('c1', { id: 'm-alive', content: '같은 순간의 살아 있는 글', created_at: T_NEW })] as never as typeof rows;
    expect(blankKnownDeletedPreviews(rows)[0]!.latest_message).toEqual({ id: 'm-gone', content: '', created_at: T_NEW, event: null });
    expect(blankKnownDeletedPreviews(sameMomentOtherMessage)).toBe(sameMomentOtherMessage); // reverted (the moment alone) → the live message is blanked
    expect(blankKnownDeletedPreviews(rows)[1]).toBe(rows[1]);
  });
});
