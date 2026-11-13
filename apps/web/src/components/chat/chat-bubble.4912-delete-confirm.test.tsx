// @vitest-environment jsdom
//
// story 4912 follow-up (PO 11-13) — «삭제» deleted AT ONCE (no way back: the row turns into a tombstone for everybody). It asks ONCE now, with the ds confirm — danger tone, the first focus on «취소». The room's rows, a thread's original and a thread's
// replies all reach the delete through the bubble's menu, so ONE confirm in the bubble covers them (ThreadPanel is the harness here: its reply and its original are the two cases).
// (header of the harness, from story 4887 — the message menu INSIDE a thread was a dead end: «답글 달기» and «삭제» were drawn and did nothing (ThreadPanel passed neither callback).
// A thread is flat, so «답글 달기» means «write in THIS thread» (the composer takes the focus); «삭제» is the room's same tombstone, for a reply here and for the original at the top (the room's own list holds that one).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ThreadPanel } from './thread-panel';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';
import { forgetKnownDeletedForTests } from '@/lib/chat-message-deleted';

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

const dialog = () => document.querySelector('[data-slot="ds-dialog-content"]') as HTMLElement | null;
const footerButtons = () => [...document.querySelectorAll('[data-slot="ds-dialog-footer"] button')] as HTMLButtonElement[];
const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');

describe('delete message — asks once (4912 follow-up)', () => {
  it('⭐«삭제»를 누르면 요청이 나가기 前에 확인창이 뜬다 — 제목 · 본문 · 위험 단추 · 첫 초점은 «취소»(Enter 한 번으로 지우지 않는다)', async () => {
    stubFetch(true); await mount();
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    expect(dialog(), 'the confirm is open').not.toBeNull();
    expect(dialog()!.textContent).toContain(koMessages.chats.deleteMessageConfirmTitle);
    expect(dialog()!.textContent).toContain(koMessages.chats.deleteMessageConfirmBody);
    expect(deletes(), 'no request yet — the old behaviour deleted right here').toHaveLength(0);
    const [cancel, confirm] = footerButtons();
    expect([cancel!.textContent, confirm!.textContent]).toEqual([koMessages.common.cancel, koMessages.common.delete]);
    expect(confirm!.className).toContain('border-ds-failed');
    expect(document.activeElement).toBe(cancel);
  });

  it('⭐«취소» · Esc는 아무것도 지우지 않는다 — 창이 닫히고 글은 그대로 · 요청 0', async () => {
    stubFetch(true); await mount();
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    await click(footerButtons()[0]!); // 취소
    expect(dialog()).toBeNull();
    expect(deletes()).toHaveLength(0);
    expect(container.textContent).toContain('내 답글');
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    expect(dialog()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it('⭐확인하면 그때 DELETE가 한 번 나가고 창이 닫힌다(답글)', async () => {
    stubFetch(true); await mount();
    await openMenu('내 답글');
    await click(menuItem(koMessages.common.delete)!);
    await click(footerButtons()[1]!);
    expect(deletes().map(([u]) => String(u))).toEqual(['/api/conversations/conv-1/messages/r-mine']);
    expect(dialog()).toBeNull();
  });

  it('⭐스레드 원글도 같다 — 확인 前엔 방에 id를 넘기지 않고 확인하면 한 번 넘긴다', async () => {
    stubFetch(true); const onDeleteParent = vi.fn(); await mount(onDeleteParent);
    await openMenu('내 원본 글');
    await click(menuItem(koMessages.common.delete)!);
    expect(onDeleteParent).not.toHaveBeenCalled();
    await click(footerButtons()[0]!); // cancel
    expect(onDeleteParent).not.toHaveBeenCalled();
    await openMenu('내 원본 글');
    await click(menuItem(koMessages.common.delete)!);
    await click(footerButtons()[1]!);
    expect(onDeleteParent).toHaveBeenCalledTimes(1);
    expect(onDeleteParent).toHaveBeenCalledWith('p1');
  });

  it('⭐확인창이 열려 있는 동안 그 글이 지워진 것으로 바뀌면(다른 창에서 지움 · 서버 프레임) 확인창은 닫힌다 — 이미 지운 글을 또 지우자고 묻지 않는다', async () => {
    const onDelete = vi.fn();
    const mine = msg({ id: 'solo', created_by: 'me-1', content: '내 글 하나' });
    const draw = (m: ChatMessage) => act(async () => { root.render(wrap(<ChatBubble message={m} isMine onDelete={onDelete} />)); });
    await draw(mine);
    await act(async () => { (container.querySelector('.group\\/bubble') as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 })); });
    await click(menuItem(koMessages.common.delete)!);
    expect(dialog(), 'open').not.toBeNull();
    await draw({ ...mine, content: '', deleted_at: '2026-11-13T00:00:00.000Z' } as ChatMessage);
    expect(dialog(), 'closed once the message is a tombstone').toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('⭐확인창이 닫히면(취소 · Esc · 확인) 초점이 <body>로 떨어지지 않고 그 글의 줄로 돌아간다 — 메뉴 항목은 이미 사라져 돌려줄 곳이 없었다(codex 1차)', async () => {
    stubFetch(true); await mount();
    const row = () => rowOf('내 답글');
    const later = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // cancel
    await openMenu('내 답글'); await click(menuItem(koMessages.common.delete)!);
    await click(footerButtons()[0]!); await later();
    expect(document.activeElement, 'cancel → the row').toBe(row());
    // Esc
    (document.activeElement as HTMLElement).blur();
    await openMenu('내 답글'); await click(menuItem(koMessages.common.delete)!);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await later();
    expect(document.activeElement, 'Esc → the row').toBe(row());
    // confirm
    (document.activeElement as HTMLElement).blur();
    await openMenu('내 답글'); await click(menuItem(koMessages.common.delete)!);
    const sameRow = row();
    await click(footerButtons()[1]!); await later();
    expect(document.activeElement, 'confirm → the SAME row (now its tombstone), not another one').toBe(sameRow);
  });

  it('⭐돌려주기는 그 사이 초점을 가져간 사람을 밀어내지 않는다 — 닫힌 직후 사용자가 다른 칸에 초점을 두면 그대로(codex 2차)', async () => {
    stubFetch(true); await mount();
    const other = document.createElement('input'); document.body.appendChild(other);
    await openMenu('내 답글'); await click(menuItem(koMessages.common.delete)!);
    // hold the row's deferred hand-back (the one that touches rowRef) so the user's move can come first, deterministically
    const held: Array<() => void> = [];
    const real = window.setTimeout.bind(window);
    const spy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler, ...rest: unknown[]) => (
      String(fn).includes('rowRef') ? (held.push(fn as () => void), 0) : real(fn as () => void, ...(rest as []))
    )) as unknown as typeof window.setTimeout);
    await click(footerButtons()[0]!); // cancel → the hand-back is scheduled (held)
    expect(held, 'the hand-back was scheduled').toHaveLength(1);
    other.focus(); // the user moved on before it fires
    spy.mockRestore();
    await act(async () => { held[0]!(); });
    expect(document.activeElement, 'not pushed off').toBe(other);
    other.remove();
  });

  it('줄의 초점 표시: 키보드로 올 때만 보이는 링(focus-visible) — 윤곽선을 무조건 지우지 않는다(codex 2차)', async () => {
    stubFetch(true); await mount();
    expect(rowOf('내 답글').className).toContain('focus-visible:ring-2');
  });

  it('남의 글에는 «삭제»도 확인창도 없다(권한 그대로) · 이미 지워진 글에도 다시 안 물음', async () => {
    stubFetch(true); await mount();
    await openMenu('남의 답글');
    expect(menuItem(koMessages.common.delete)).toBeUndefined();
    expect(dialog()).toBeNull();
  });
});
