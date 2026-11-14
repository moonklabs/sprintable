// @vitest-environment jsdom
//
// story 4954 (the desktop app's notification list) — ↑ ↓ (j k) walk the list rows (single lines and a grouped line's header), focus only; Enter / Space open as before. Reverting the row marks or the container's key handler → RED.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../../messages/ko.json';

const { useDashboardContextMock, nav } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn(), nav: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('../../dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/components/inbox/approvals-queue', () => ({ ApprovalsQueue: () => null }));
vi.mock('@/components/attention-queue/attention-queue-view', () => ({ AttentionQueueView: () => null }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const n = (id: string, title: string, type = 'story_assigned', extra: Record<string, unknown> = {}) => ({ id, type, title, body: null, is_read: false, reference_type: null, reference_id: null, href: null, created_at: new Date().toISOString(), ...extra });
let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  nav.push.mockReset();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectId: 'proj-1' });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function mount(list: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/notifications')) return { ok: true, json: async () => ({ data: list, meta: { unreadCount: list.length, hasMore: false, nextCursor: null } }) };
    if (url.includes('/api/workflow-executions')) return { ok: true, json: async () => ({ items: [] }) };
    return { ok: false, status: 404, json: async () => null };
  }));
  const { default: InboxPage } = await import('./page');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><TopBarProvider><InboxPage /></TopBarProvider></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-row-key]')];
const focusables = () => rows().map((r) => (r.querySelector<HTMLElement>('[data-row-focus]') ?? r.querySelector<HTMLElement>('button'))!);
const key = async (el: Element, k: string, init: KeyboardEventInit = {}) => { const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }); await act(async () => { el.dispatchEvent(e); }); return e; };

describe('[SID:4954] the notification list — ↑ ↓ walk the rows', () => {
  it('⭐↓ ↑ j k move the focus between single rows; the ends stay; no row opens', async () => {
    await mount([n('a', '첫째 배정'), n('b', '둘째 배정'), n('c', '셋째 배정')]);
    expect(rows()).toHaveLength(3); const f = focusables(); f[0]!.focus();
    const down = await key(f[0]!, 'ArrowDown'); expect(down.defaultPrevented).toBe(true); expect(document.activeElement).toBe(f[1]);
    await key(f[1]!, 'j'); expect(document.activeElement).toBe(f[2]);
    await key(f[2]!, 'ArrowDown'); expect(document.activeElement).toBe(f[2]);
    await key(f[2]!, 'k'); expect(document.activeElement).toBe(f[1]);
    await key(f[1]!, 'ArrowUp'); expect(document.activeElement).toBe(f[0]);
    expect(nav.push).not.toHaveBeenCalled();
  });
  it('⭐a grouped line is one row: the keys land on its HEADER button (not the chevron), and move on to the next row', async () => {
    const same = (id: string) => n(id, '시스템 발행님이 나를 멘션했어요', 'conversation.mention', { title: '시스템 발행님이 나를 멘션했어요' });
    await mount([n('a', '첫째 배정'), same('g1'), same('g2'), same('g3'), n('z', '끝 배정')]);
    const r = rows(); const gi = r.findIndex((x) => x.querySelector('[aria-expanded]')); expect(gi, 'the three same lines are ONE grouped row').toBeGreaterThanOrEqual(0);
    const f = focusables(); const other = gi === 0 ? 1 : gi - 1; f[other]!.focus();
    await key(f[other]!, gi === 0 ? 'ArrowUp' : 'ArrowDown'); // a single row's neighbour is the group (or the first row going up)
    f[gi === 0 ? 1 : other]!.focus(); await key(document.activeElement!, gi > other ? 'ArrowDown' : 'ArrowUp');
    const header = r[gi]!.querySelector('[data-row-focus]'); expect(header, 'the header button is the row\'s focus target').not.toBeNull();
    expect(document.activeElement).toBe(header); expect(document.activeElement?.hasAttribute('aria-expanded')).toBe(false); // not the chevron
    const after = gi + 1 < r.length ? 'ArrowDown' : 'ArrowUp'; await key(document.activeElement!, after); expect(r[after === 'ArrowDown' ? gi + 1 : gi - 1]!.contains(document.activeElement)).toBe(true);
  });
  it('a modified key (⌘ ↓) is not taken', async () => {
    await mount([n('a', '첫째 배정'), n('b', '둘째 배정')]);
    const f = focusables(); f[0]!.focus(); const e = await key(f[0]!, 'ArrowDown', { metaKey: true }); expect(e.defaultPrevented).toBe(false); expect(document.activeElement).toBe(f[0]);
  });
});
