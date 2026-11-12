// @vitest-environment jsdom
//
// story 4887 — the message menu INSIDE a thread was a dead end: «답글 달기» and «삭제» were drawn and did nothing (ThreadPanel passed neither callback).
// A thread is flat, so «답글 달기» means «write in THIS thread» (the composer takes the focus); «삭제» is the room's same tombstone, for a reply here and for the original at the top (the room's own list holds that one).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ThreadPanel } from './thread-panel';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import { CHAT_MESSAGE_DELETED_EVENT, forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const addToast = vi.fn();
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ addToast }) }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'me-1' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
// the real composer is out of scope; a textarea stands where it stands so «the composer takes the focus» is a real DOM fact
vi.mock('./chat-input', () => ({ ChatInput: () => <textarea data-testid="mock-composer" /> }));

let container: HTMLDivElement;
let root: Root;
const wrap = (node: React.ReactNode) => (<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>);

const msg = (o: Partial<ChatMessage> & { id: string; created_by: string; content: string }): ChatMessage => ({
  memo_id: 'conv-1', sender_name: o.created_by === 'me-1' ? '나' : '유나', sender_type: 'human', sender_avatar_url: null, sender_runtime_type: null, attachments: [], created_at: '2026-11-11T00:00:00.000Z', ...o,
}) as ChatMessage;
const parentMine = msg({ id: 'p1', created_by: 'me-1', content: '내 원본 글' });
const REPLIES = [
  msg({ id: 'r-mine', parent_id: 'p1', created_by: 'me-1', content: '내 답글', created_at: '2026-11-11T00:01:00.000Z' }),
  msg({ id: 'r-other', parent_id: 'p1', created_by: 'other-1', content: '남의 답글', created_at: '2026-11-11T00:02:00.000Z' }),
] as ChatMessage[];

const fetchMock = vi.fn();
function stubFetch(deleteOk: boolean) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return deleteOk ? { ok: true, status: 200, json: async () => ({ deleted_at: '2026-11-11T01:00:00.000Z' }) } : { ok: false, status: 500, json: async () => ({}) };
    if (String(url).includes('thread_id=')) return { ok: true, status: 200, json: async () => ({ data: REPLIES }) };
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
}
async function mount(onDeleteParent?: (id: string) => void) {
  await act(async () => { root.render(wrap(<ThreadPanel parentMessage={parentMine} conversationId="conv-1" currentTeamMemberId="me-1" projectId="proj-1" onClose={() => {}} onDeleteParent={onDeleteParent} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const rowOf = (text: string) => [...container.querySelectorAll('[data-testid="chat-bubble-text"]')].find((e) => e.textContent?.includes(text))!.closest('.group\\/bubble') as HTMLElement;
async function openMenu(text: string) {
  await act(async () => { rowOf(text).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
}
const menuItem = (label: string) => [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes(label)) as HTMLElement | undefined;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); addToast.mockReset(); });
afterEach(() => { forgetKnownDeletedForTests(); act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('ThreadPanel — the message menu works (story 4887)', () => {
  it('⭐ «답글 달기» on a reply puts the focus in this thread\'s composer', async () => {
    stubFetch(true); await mount();
    await openMenu('남의 답글');
    await click(menuItem(koMessages.chats.replyToMessage)!);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="mock-composer"]')); // reverted (no callback) → the focus stays on <body>
  });

  it('⭐ «답글 달기» on the ORIGINAL at the top does the same', async () => {
    stubFetch(true); await mount();
    await openMenu('내 원본 글');
    await click(menuItem(koMessages.chats.replyToMessage)!);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="mock-composer"]'));
  });

  it('⭐ «삭제» on my reply sends DELETE to the same endpoint the room uses and leaves a tombstone in its place', async () => {
    stubFetch(true); await mount();
    const heard: unknown[] = [];
    const listen = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    window.removeEventListener(CHAT_MESSAGE_DELETED_EVENT, listen);
    expect(heard, 'the panel announces the delete so the room LIST blanks a preview that showed this reply').toEqual([{ conversationId: 'conv-1', createdAt: '2026-11-11T00:01:00.000Z', messageId: 'r-mine', threadId: 'p1', deletedAt: '2026-11-11T01:00:00.000Z' }]); // story 4903 (codex on 5664): with the message's id
    const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
    expect(String(del?.[0])).toBe('/api/conversations/conv-1/messages/r-mine'); // reverted → no DELETE at all
    expect(container.textContent).not.toContain('내 답글');
    expect(container.textContent).toContain(koMessages.chats.deletedMessagePlaceholder); // the row stays as a placeholder
    expect(container.textContent).toContain('남의 답글'); // the other reply is untouched
    expect(addToast).not.toHaveBeenCalled();
  });

  it('⭐ a failed delete is SHOWN (a toast) and the reply stays — never a silent nothing', async () => {
    stubFetch(false); await mount();
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toMatchObject({ type: 'error', title: koMessages.chats.deleteMessageErrorTitle });
    expect(container.textContent).toContain('내 답글');
  });

  it('⭐ «삭제» on the ORIGINAL hands the id to the room (its list holds that message) — no DELETE from the panel itself', async () => {
    stubFetch(true); const onDeleteParent = vi.fn(); await mount(onDeleteParent);
    await openMenu('내 원본 글');
    await click(menuItem(koMessages.common.delete)!);
    expect(onDeleteParent).toHaveBeenCalledWith('p1');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('⭐ the «삭제» condition is the room\'s (mine AND not already deleted): after deleting, the tombstone row offers no «삭제» again', async () => {
    stubFetch(true); await mount();
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    const tomb = [...container.querySelectorAll('[data-testid="thread-replies"] .group\\/bubble')].find((r) => r.textContent?.includes(koMessages.chats.deletedMessagePlaceholder)) as HTMLElement; // the tombstone row has no text test-id: find the ROW by its words
    await act(async () => { tomb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
    expect(menuItem(koMessages.common.delete)).toBeUndefined(); // reverted (a gate on isMine alone) → a second DELETE is offered for a message that is gone
    expect(menuItem(koMessages.chats.replyToMessage)).toBeDefined(); // the rest of the menu is still there
  });

  it('someone else\'s reply has no «삭제» (permission unchanged) and the thread still draws NO hover reply button (the menu is the only way)', async () => {
    stubFetch(true); await mount();
    await openMenu('남의 답글');
    expect(menuItem(koMessages.common.delete)).toBeUndefined();
    expect(container.querySelector('[data-testid="chat-bubble-reply-button"], [data-testid="chat-bubble-reply-button-touch"]')).toBeNull(); // reverted to passing onOpenThread → the buttons appear in the thread
  });
});
