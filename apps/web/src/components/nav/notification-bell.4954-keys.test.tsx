// @vitest-environment jsdom
//
// story 4954 (the desktop app's bell) — ↑ ↓ (j k) walk the rows of the open panel, focus only (the list keys the home · goals · runs lists use); Enter / Space open a row as a button does. Reverting the row marks → RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));
vi.mock('@/hooks/use-sse-notifications', () => ({ useSseNotifications: () => undefined }));
const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: string, headline: string, read = false) => ({
  id, event_type: 'dispatched', source_entity_type: 'gate', source_entity_id: `${id}-g`,
  payload: { title: headline, event_type: 'gate.pending_approval', gate_name: headline }, read_at: read ? '2026-11-10T12:00:00Z' : null, created_at: '2026-11-10T12:00:00Z',
});
let container: HTMLDivElement; let root: Root; let listItems: unknown[] = []; let more = false;
beforeEach(() => {
  nav.push.mockReset(); more = false;
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) return new Response(JSON.stringify({ data: listItems, meta: { hasMore: more } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ count: listItems.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openBell() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><NotificationBell /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const rowButtons = () => [...document.querySelectorAll<HTMLElement>('[data-dropdown-panel="notification-bell"] li[data-row-key] button')];
const key = async (el: Element, k: string, init: KeyboardEventInit = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); await act(async () => { el.dispatchEvent(e); }); return e; };

describe('[SID:4954] the bell panel — ↑ ↓ walk the rows', () => {
  it('⭐↓ moves the focus to the next row, ↑ to the one before; j k the same; the ends stay put; nothing opens', async () => {
    listItems = [item('n1', '첫째'), item('n2', '둘째'), item('n3', '셋째')]; await openBell();
    const rows = rowButtons(); expect(rows).toHaveLength(3); // each row is a «data-row-key» (reverted → 0)
    rows[0]!.focus();
    const down = await key(rows[0]!, 'ArrowDown'); expect(down.defaultPrevented).toBe(true); expect(document.activeElement).toBe(rows[1]);
    await key(rows[1]!, 'ArrowDown'); expect(document.activeElement).toBe(rows[2]);
    await key(rows[2]!, 'ArrowDown'); expect(document.activeElement).toBe(rows[2]); // the end stays
    await key(rows[2]!, 'ArrowUp'); expect(document.activeElement).toBe(rows[1]);
    await key(rows[1]!, 'j'); expect(document.activeElement).toBe(rows[2]);
    await key(rows[2]!, 'k'); expect(document.activeElement).toBe(rows[1]);
    rows[0]!.focus(); await key(rows[0]!, 'ArrowUp'); expect(document.activeElement).toBe(rows[0]);
    expect(nav.push).not.toHaveBeenCalled();
  });
  it('a modified key (⌘ ↓) is not taken', async () => {
    listItems = [item('n1', '첫째'), item('n2', '둘째')]; await openBell();
    const rows = rowButtons(); rows[0]!.focus();
    const e = await key(rows[0]!, 'ArrowDown', { metaKey: true }); expect(e.defaultPrevented).toBe(false); expect(document.activeElement).toBe(rows[0]);
  });
  it('the keys also walk across the «안 읽음» and «이전» groups (one list)', async () => {
    listItems = [item('n1', '안읽음 하나'), item('n2', '읽은 하나', true)]; await openBell();
    const rows = rowButtons(); expect(rows).toHaveLength(2);
    rows[0]!.focus(); await key(rows[0]!, 'ArrowDown'); expect(document.activeElement).toBe(rows[1]);
  });
  it('⭐«더 보기» is not a row: ↓ · ↑ on it do NOT jump the focus to the first / last notification', async () => {
    more = true; listItems = [item('n1', '첫째'), item('n2', '둘째')]; await openBell();
    const loadMore = [...document.querySelectorAll<HTMLElement>('[data-dropdown-panel="notification-bell"] button')].find((b) => b.textContent?.includes(koMessages.inbox.loadMore));
    expect(loadMore, 'the «더 보기» button').toBeTruthy(); loadMore!.focus();
    const d = await key(loadMore!, 'ArrowDown'); expect(d.defaultPrevented).toBe(false); expect(document.activeElement).toBe(loadMore);
    const u = await key(loadMore!, 'k'); expect(u.defaultPrevented).toBe(false); expect(document.activeElement).toBe(loadMore);
  });
});
