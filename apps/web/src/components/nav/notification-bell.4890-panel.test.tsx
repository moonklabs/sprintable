// @vitest-environment jsdom
//
// story 4890 (UI-7 P10 · «누가 · 어느 방») — a chat line in the bell shows WHO (the sender's Avatar instead of the generic bell) and WHERE (the room's name under the headline, when the list carries it). Before: ten lines of
// «새 메시지 · 시각» told a person nothing about who or which room (measured: 0/10). Every other kind of line keeps the bell icon; a room with no name (a DM · a room the server withheld) draws no room line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => undefined }));
const { NotificationBell, chatLineSender } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chat = (id: string, over: Record<string, unknown> = {}, sender: Record<string, unknown> | null = { id: 's1', name: '에이전트 N', type: 'agent', avatar_url: null, runtime_type: 'claude-code' }) => ({
  id, event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: `${id}-m`,
  payload: { summary: '에이전트 N: 안녕하세요', conversation_id: 'room-1', ...(sender ? { sender } : {}) }, read_at: null, created_at: '2026-11-10T12:00:00Z', ...over,
});
const gate = () => ({
  id: 'gate-1', event_type: 'dispatched', source_entity_type: 'gate', source_entity_id: 'g-1',
  payload: { title: '결재 대기', event_type: 'gate.pending_approval', gate_name: '4890' }, read_at: null, created_at: '2026-11-10T12:00:00Z',
});

let container: HTMLDivElement;
let root: Root;
let listItems: unknown[] = [];
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) return new Response(JSON.stringify({ data: listItems, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ count: listItems.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openBell() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]')!;
const lines = () => Array.from(panel().querySelectorAll<HTMLElement>('ul > li'));


const read = (id: string) => chat(id, { read_at: '2026-11-10T13:00:00Z', target_conversation_title: '옛 방' });
const unread = (id: string) => chat(id, { target_conversation_title: '새 방' });

describe('NotificationBell — the panel on the B skeleton (story 4890)', () => {
  it('⭐the «all» view is two groups: «안 읽음 N» (with its count) first, «이전» after; each row sits in its own group', async () => {
    listItems = [read('r1'), unread('u1'), unread('u2'), read('r2')];
    await openBell();
    const u = panel().querySelector('[data-testid="notification-group-unread"]')!;
    const e = panel().querySelector('[data-testid="notification-group-earlier"]')!;
    expect(u).not.toBeNull(); expect(e).not.toBeNull();
    expect(u.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0); // unread first
    expect(u.textContent).toContain(koMessages.inbox.groupUnread);
    expect(u.querySelector('[data-slot="ds-count-badge"]')?.textContent).toBe('2');
    expect(u.querySelectorAll('ul > li')).toHaveLength(2);
    expect(e.textContent).toContain(koMessages.inbox.groupEarlier);
    expect(e.querySelectorAll('ul > li')).toHaveLength(2);
  });

  it('only one group present → no second header (all read: just the list, no «이전» title)', async () => {
    listItems = [read('r1'), read('r2')];
    await openBell();
    expect(panel().querySelector('[data-testid="notification-group-unread"]')).toBeNull();
    expect(panel().querySelector('[data-testid="notification-group-earlier"] [data-slot="ds-section-header"]')).toBeNull(); // (the text «이전» also sits inside «에이전트» — look for the header part, not the words)
  });

  it('a filter (a tab or «안읽음만») shows one flat list — no groups', async () => {
    listItems = [read('r1'), unread('u1')];
    await openBell();
    const only = Array.from(panel().querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).find((b) => b.textContent === koMessages.inbox.unreadOnly)!;
    await act(async () => { only.click(); });
    expect(panel().querySelector('[data-testid="notification-group-unread"]')).toBeNull();
    expect(panel().querySelectorAll('ul > li')).toHaveLength(1);
  });

  it('a row is TWO lines: the headline, then «방 · 보낸이 · 시각» in one line (the room keeps its own testid)', async () => {
    listItems = [chat('c1', { target_conversation_title: '개발 방' })];
    await openBell();
    const row = lines()[0]!;
    const textLines = Array.from(row.querySelectorAll('button > span > span.block')).map((s) => s.textContent);
    expect(textLines).toHaveLength(2);
    expect(textLines[0]).toBe('에이전트 N: 안녕하세요');
    expect(row.querySelector('[data-testid="notification-line-room"]')?.textContent).toBe('개발 방');
    expect(textLines[1]).toMatch(/^개발 방 · /); // the room, then the time
    expect(row.querySelectorAll('p')).toHaveLength(0); // no separate paragraph per fact any more
  });

  it('the chips are ONE row (3 kinds + 안읽음만, all aria-pressed), the header close is a named 44 icon button, and [전체 읽음] shows only with something unread', async () => {
    listItems = [unread('u1')];
    await openBell();
    const pressed = Array.from(panel().querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
    expect(pressed.map((b) => b.textContent)).toEqual([koMessages.inbox.filterAll, koMessages.inbox.filter_story, koMessages.inbox.filter_system, koMessages.inbox.unreadOnly]);
    expect(new Set(pressed.map((b) => b.parentElement)).size).toBe(1);
    expect(pressed[0]!.getAttribute('aria-pressed')).toBe('true');
    const close = panel().querySelector<HTMLButtonElement>(`button[aria-label="${koMessages.common.close}"]`)!;
    expect(close.getAttribute('data-slot')).toBe('ds-icon-button');
    expect(close.className).toContain('touch:min-h-ds-touch'); // the ds touch floor token (develop 5619 renamed it from touch:min-h-11 · the value is still 44)
    expect(Array.from(panel().querySelectorAll('button')).some((b) => b.textContent?.includes(koMessages.inbox.markAllRead))).toBe(true);
  });

  it('nothing unread → no [전체 읽음]', async () => {
    listItems = [read('r1')];
    await openBell();
    expect(Array.from(panel().querySelectorAll('button')).some((b) => b.textContent?.includes(koMessages.inbox.markAllRead))).toBe(false);
  });
});
