// @vitest-environment jsdom
//
// story 4946 (the desktop app's chat list) — ↑ ↓ walk the room rows (focus only), and a right-click on a row opens the room's own menu (the «⋯» items: mute · notification settings, no more).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChatListView } from './chat-list-view';
import { ToastProvider } from '@/components/ui/toast';

vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: () => {} }));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/hooks/use-chat-sse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-sse')>();
  return { ...actual, useChatSse: () => ({ connected: true, polling: false }) };
});
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ isAlive: () => false, subscribe: () => () => {}, subscribeMessage: () => () => {}, subscribeReconnect: () => () => {}, connected: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  nav.push.mockReset(); nav.replace.mockReset();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ projectMemberships: [], role: 'member', orgMemberships: [], currentMemberType: 'human' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.querySelectorAll('[role="menu"]').forEach((e) => e.remove()); vi.unstubAllGlobals(); });

const T = '2026-11-14T01:00:00.000001+00:00';
const room = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'group', title: `방 ${id}`, latest_message: { content: `글 ${id}`, created_at: T }, updated_at: T, unread_count: 0, participants: [], muted: false, free_response: false, ...over });
const rowOf = (title: string) => [...container.querySelectorAll('[data-testid="chat-list-rooms"] button')].find((b) => b.textContent?.includes(title)) as HTMLElement;
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const muteCalls: { url: string; body: string }[] = [];
function stub(rooms: object[], muteStatus = 200) {
  muteCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.includes('/mute')) { muteCalls.push({ url, body: String(init?.body) }); if (muteStatus === 0) throw new TypeError('fetch failed'); return { ok: muteStatus < 400, status: muteStatus, json: async () => ({}) }; }
    if (url.includes('/api/conversations/recent-outside-project')) return { ok: true, json: async () => ({ data: [] }) };
    if (url.includes('/api/conversations?')) return { ok: true, json: async () => ({ data: rooms, total: rooms.length }) };
    return { ok: false, status: 404, json: async () => null };
  }));
}
async function mount() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ToastProvider><ChatListView projectId="proj-current" currentTeamMemberId="me-1" /></ToastProvider></NextIntlClientProvider>); });
  await flush();
}
const key = async (el: Element, k: string) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); await act(async () => { el.dispatchEvent(e); }); return e; };
const rightClick = async (el: Element) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }); await act(async () => { el.dispatchEvent(e); }); return e; };
const menu = () => document.body.querySelector('[data-testid="room-row-menu"]') as HTMLElement | null;
const items = () => [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((b) => b.textContent?.trim());

describe('[SID:4946] ChatListView — the arrow keys walk the room rows', () => {
  it('⭐↓ moves the focus to the next room, ↑ to the one before — and the keys j · k the same (the list keys the home · goals lists use)', async () => {
    stub([room('a'), room('b'), room('c')]); await mount();
    rowOf('방 a').focus();
    const down = await key(rowOf('방 a'), 'ArrowDown');
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rowOf('방 b'));
    await key(rowOf('방 b'), 'ArrowDown'); expect(document.activeElement).toBe(rowOf('방 c'));
    await key(rowOf('방 c'), 'ArrowUp'); expect(document.activeElement).toBe(rowOf('방 b'));
    await key(rowOf('방 b'), 'j'); expect(document.activeElement).toBe(rowOf('방 c'));
    await key(rowOf('방 c'), 'k'); expect(document.activeElement).toBe(rowOf('방 b'));
  });
  it('the ends stay put (↑ on the first · ↓ on the last do nothing), and a key never OPENS a room: moving is focus only', async () => {
    stub([room('a'), room('b')]); await mount();
    rowOf('방 a').focus(); await key(rowOf('방 a'), 'ArrowUp'); expect(document.activeElement).toBe(rowOf('방 a'));
    rowOf('방 b').focus(); await key(rowOf('방 b'), 'ArrowDown'); expect(document.activeElement).toBe(rowOf('방 b'));
    expect(nav.push).not.toHaveBeenCalled(); expect(nav.replace).not.toHaveBeenCalled();
  });
  it('a modified key (⌘ ↓) is not taken: the app\'s own shortcuts keep working', async () => {
    stub([room('a'), room('b')]); await mount();
    rowOf('방 a').focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true, bubbles: true, cancelable: true }); await act(async () => { rowOf('방 a').dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(false); expect(document.activeElement).toBe(rowOf('방 a'));
  });
  it('the row keeps its button inside (Enter · Space still open it as before) — the layout is the button\'s', async () => {
    stub([room('a')]); await mount();
    const b = rowOf('방 a');
    expect(b.tagName).toBe('BUTTON'); expect(b.parentElement?.getAttribute('data-row-key')).toBe('a');
    await act(async () => { b.click(); }); expect(nav.push).toHaveBeenCalledTimes(1);
  });
});

describe('[SID:4946] ChatListView — a right-click on a room row opens the room\'s menu (only what the room\'s «⋯» menu has)', () => {
  it('⭐the menu replaces the browser\'s: the event is prevented, and it holds exactly the two items of the room\'s own «⋯» menu', async () => {
    stub([room('a')]); await mount();
    const e = await rightClick(rowOf('방 a'));
    expect(e.defaultPrevented).toBe(true);
    expect(items()).toEqual([koMessages.chats.muteNotifications, koMessages.chats.deliveryContractTitle]);
    expect(document.activeElement?.textContent).toContain(koMessages.chats.muteNotifications); // the first item has the focus: the keys work at once
  });
  it('⭐«알림 끄기» flips the room\'s mute (PATCH /mute { muted: true }) and the menu then says «알림 켜기»; the room is NOT opened', async () => {
    stub([room('a')]); await mount();
    await rightClick(rowOf('방 a'));
    await act(async () => { (menu()!.querySelector('[data-testid="room-row-mute"]') as HTMLElement).click(); }); await flush();
    expect(muteCalls).toHaveLength(1); expect(muteCalls[0]!.url).toContain('/api/conversations/a/mute'); expect(JSON.parse(muteCalls[0]!.body)).toEqual({ muted: true });
    expect(menu()).toBeNull(); expect(nav.push).not.toHaveBeenCalled();
    await rightClick(rowOf('방 a')); expect(items()[0]).toBe(koMessages.chats.unmuteNotifications);
  });
  it('a muted room says «알림 켜기» first, and flipping it sends { muted: false }', async () => {
    stub([room('a', { muted: true })]); await mount();
    await rightClick(rowOf('방 a')); expect(items()[0]).toBe(koMessages.chats.unmuteNotifications);
    await act(async () => { (menu()!.querySelector('[data-testid="room-row-mute"]') as HTMLElement).click(); }); await flush();
    expect(JSON.parse(muteCalls[0]!.body)).toEqual({ muted: false });
  });
  it('⭐a failed flip is put back (the room stays as it was) — never a silent change', async () => {
    stub([room('a')], 500); await mount();
    await rightClick(rowOf('방 a'));
    await act(async () => { (menu()!.querySelector('[data-testid="room-row-mute"]') as HTMLElement).click(); }); await flush();
    await rightClick(rowOf('방 a')); expect(items()[0]).toBe(koMessages.chats.muteNotifications);
  });
  it('⭐a flip that never reaches the server (the network) is put back too', async () => {
    stub([room('a')], 0); await mount();
    await rightClick(rowOf('방 a'));
    await act(async () => { (menu()!.querySelector('[data-testid="room-row-mute"]') as HTMLElement).click(); }); await flush();
    await rightClick(rowOf('방 a')); expect(items()[0]).toBe(koMessages.chats.muteNotifications);
  });
  it('«알림 설정» opens the room\'s notification settings window (the room\'s own window, for THIS room)', async () => {
    stub([room('a')]); await mount();
    await rightClick(rowOf('방 a'));
    await act(async () => { (menu()!.querySelector('[data-testid="room-row-settings"]') as HTMLElement).click(); }); await flush();
    expect(menu()).toBeNull();
    const dlg = document.body.querySelector('[role="dialog"]');
    expect(dlg?.textContent ?? '').toContain(koMessages.chats.deliveryContractTitle);
    expect(nav.push).not.toHaveBeenCalled();
  });
  it('⭐Esc closes the menu and the focus goes back to the row (a keyboard person is not left on the page body)', async () => {
    stub([room('a'), room('b')]); await mount();
    await rightClick(rowOf('방 b'));
    await key(menu()!, 'Escape'); await flush();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(rowOf('방 b'));
  });
  it('↓ · ↑ move between the two items; an outside press closes the menu', async () => {
    stub([room('a')]); await mount();
    await rightClick(rowOf('방 a'));
    await key(menu()!, 'ArrowDown'); expect(document.activeElement?.textContent).toContain(koMessages.chats.deliveryContractTitle);
    await key(menu()!, 'ArrowDown'); expect(document.activeElement?.textContent).toContain(koMessages.chats.muteNotifications);
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); }); await flush();
    expect(menu()).toBeNull();
  });
});
