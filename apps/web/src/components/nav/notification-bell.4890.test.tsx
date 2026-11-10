// @vitest-environment jsdom
//
// story 4890 (UI-7 · PO 11-10) — one chat message is ONE bell line and ONE unread. Measured on dev: an agent's 2 messages → 4 lines («New message» ×2 next to «Agent N: …» ×2) and a badge of 4, because each message wrote the
// `conversation.message_created` row AND a `dispatched` copy (payload.event_type `conversation.message`, story 1934's push notification). The server now leaves the copy out of the list and the count; the bell also
// leaves it out of what it draws (a list from an older server · the live SSE feed) so they never disagree: no second line, no «mark all read» for something nobody can see, no +1 and no second desktop notification.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
const sse = vi.hoisted(() => ({ onNotification: null as null | ((n: Record<string, unknown>) => void) }));
vi.mock('@/hooks/use-sse-notifications', () => ({
  useSseNotifications: (opts: { onNotification: (n: Record<string, unknown>) => void }) => { sse.onNotification = opts.onNotification; },
}));
const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const created = (id: string, summary: string) => ({
  id, event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: `${id}-msg`,
  payload: { summary, conversation_id: 'room-1', sender: { name: '에이전트' } }, read_at: null, created_at: '2026-11-10T12:00:00Z',
});
const copy = (id: string, body: string) => ({
  id, event_type: 'dispatched', source_entity_type: 'conversation', source_entity_id: 'room-1',
  payload: { title: '에이전트님의 새 메시지', body, event_type: 'conversation.message' }, read_at: null, created_at: '2026-11-10T12:00:00Z',
});
const gate = () => ({
  id: 'gate-1', event_type: 'dispatched', source_entity_type: 'gate', source_entity_id: 'g-1',
  payload: { title: '결재 대기 중인 게이트가 있어요', event_type: 'gate.pending_approval', gate_name: '4890' }, read_at: null, created_at: '2026-11-10T12:00:00Z',
});

let container: HTMLDivElement;
let root: Root;
let listItems: unknown[] = [];
let serverUnread = 0;

beforeEach(() => {
  sse.onNotification = null;
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      return new Response(JSON.stringify({ data: listItems, meta: { hasMore: false } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ count: serverUnread }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  const bell = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
  await act(async () => { bell.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return bell;
}
const panel = () => document.querySelector<HTMLElement>('[data-dropdown-panel="notification-bell"]')!;
const headlines = () => Array.from(panel().querySelectorAll('p.truncate.text-sm')).map((p) => p.textContent);
const markAllReadButton = () => Array.from(panel().querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.inbox.markAllRead));

describe('NotificationBell — a chat message is one line (story 4890)', () => {
  it('⭐2 messages (each with its dispatched copy) draw 2 lines — the message_created rows — and the copy\'s «새 메시지» line is not there; other dispatched kinds still are', async () => {
    listItems = [created('c2', '에이전트: 두 번째 글'), copy('d2', '두 번째 글'), created('c1', '에이전트: 첫 번째 글'), copy('d1', '첫 번째 글'), gate()];
    serverUnread = 3;
    await openBell();
    expect(headlines()).toEqual(['에이전트: 두 번째 글', '에이전트: 첫 번째 글', '결재 요청 · 4890']);
    expect(headlines().includes('새 메시지')).toBe(false);
  });

  it('⭐a list whose only unread rows are copies (an older server) offers no «전체 읽음» — there is nothing to see to mark', async () => {
    listItems = [copy('d1', '글')];
    serverUnread = 0;
    await openBell();
    expect(headlines()).toEqual([]);
    expect(markAllReadButton()).toBeUndefined();
    listItems = [copy('d1', '글'), created('c1', '에이전트: 글')];
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await openBell();
    expect(markAllReadButton()).toBeDefined(); // a real unread line brings it back
  });
});

describe('NotificationBell — the live feed (story 4890)', () => {
  const live = (overrides: Record<string, unknown>) => act(async () => { sse.onNotification!({ read_at: null, created_at: '2026-11-10T12:01:00Z', ...overrides }); });
  const badge = (bell: HTMLElement) => bell.getAttribute('aria-label');

  it('⭐a live message_created adds one line and one unread; the live dispatched copy of the same message adds nothing', async () => {
    listItems = [];
    serverUnread = 0;
    const bell = await openBell();
    const before = badge(bell);
    await live({ id: 'live-c', event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: 'm-1', payload: { summary: '에이전트: 새 글', conversation_id: 'room-1' } });
    const afterCreated = badge(bell);
    expect(afterCreated).not.toBe(before);
    expect(headlines()).toEqual(['에이전트: 새 글']);
    await live({ id: 'live-d', event_type: 'dispatched', source_entity_type: 'conversation', source_entity_id: 'room-1', payload: { title: '에이전트님의 새 메시지', body: '새 글', event_type: 'conversation.message' } });
    expect(badge(bell)).toBe(afterCreated); // no second +1
    expect(headlines()).toEqual(['에이전트: 새 글']); // no second line
  });

  it('the live copy raises no desktop-bridge notification either (the message_created one already does)', async () => {
    const notifyShow = vi.fn().mockResolvedValue(true);
    (window as unknown as { __sprintableBridge?: unknown }).__sprintableBridge = { notify_show: notifyShow };
    try {
      listItems = [];
      serverUnread = 0;
      await openBell();
      await live({ id: 'live-d', event_type: 'dispatched', source_entity_type: 'conversation', source_entity_id: 'room-1', payload: { title: '에이전트님의 새 메시지', body: '새 글', event_type: 'conversation.message' } });
      expect(notifyShow).not.toHaveBeenCalled();
      await live({ id: 'live-c', event_type: 'conversation.message_created', source_entity_type: 'conversation_message', source_entity_id: 'm-1', payload: { summary: '에이전트: 새 글', conversation_id: 'room-1' } });
      expect(notifyShow).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { __sprintableBridge?: unknown }).__sprintableBridge;
    }
  });
});
