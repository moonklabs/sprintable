// @vitest-environment jsdom
//
// story 4892 (UI-9 활동 §2) — the audit log: rows grouped by DAY (오늘 · 어제 · date), each row a button that opens its details (the original action name and the
// context key/values the hover-only tooltip used to carry). Wide (lg+): the details sit in a column beside the list; narrow: they open right under the chosen row and
// the keyboard focus moves into them (aria-expanded + aria-controls on the row; closing returns focus to the row).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ActivityLogView } from './activity-log-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const { mq } = vi.hoisted(() => ({ mq: { wide: true } }));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => mq.wide }));
// the viewer's zone decides which day a row is on — pin it so the test does not depend on the machine's zone
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => 'UTC' }));
const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const NOW = new Date('2026-11-10T12:00:00Z');

const row = (id: string, created_at: string, over: Record<string, unknown> = {}) => ({
  id, actor_id: 'm1', actor_name: '안나', actor_type: 'human', action: 'story.updated', entity_type: 'story', entity_title: `일감 ${id}`,
  context: { field: 'status', to: 'done' }, created_at, ...over,
});
const ITEMS = [
  row('r1', '2026-11-10T08:00:00Z'),                                   // today (UTC)
  row('r2', '2026-11-10T01:00:00Z', { context: null }),                  // today, no context
  row('r3', '2026-11-09T20:00:00Z'),                                   // yesterday
  row('r4', '2026-11-02T10:00:00Z', { action: 'doc.deleted' }),        // older
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  mq.wide = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  fetchWithAuthMock.mockReset();
  vi.useRealTimers();
});

async function mount() {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    return { ok: true, status: 200, json: async () => ({ data: { items: ITEMS, total: ITEMS.length, limit: 30, offset: 0 } }) };
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <TopBarProvider><ActivityLogView projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const rows = () => [...container.querySelectorAll('button[aria-controls="audit-detail"]')] as HTMLButtonElement[];
const detail = () => document.getElementById('audit-detail');
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => { vi.advanceTimersByTime(5); }); };

describe('ActivityLogView — 일 단위 묶음 (4892)', () => {
  it('⭐rows sit under day headers: 오늘 · 어제 · the date — each header is a heading with its rows', async () => {
    await mount();
    const groups = [...container.querySelectorAll('[data-testid="audit-day-group"]')];
    expect(groups.map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', '어제', expect.stringContaining('11월')]);
    expect(groups.map((g) => g.querySelectorAll('button[aria-controls]').length)).toEqual([2, 1, 1]);
  });
});

describe('ActivityLogView — 행을 고르면 상세가 보인다 (4892)', () => {
  it('⭐every row is a button: aria-expanded=false, aria-controls=audit-detail, and no hover-only title tooltip', async () => {
    await mount();
    expect(rows()).toHaveLength(4);
    for (const r of rows()) {
      expect(r.getAttribute('aria-expanded')).toBe('false');
      expect(r.getAttribute('title')).toBeNull();
      expect(r.parentElement?.getAttribute('title')).toBeNull();
    }
    expect(detail()).toBeNull();
  });

  it('⭐wide: choosing a row shows its facts in the column beside the list — the action name and the context key/values', async () => {
    await mount();
    expect(container.textContent).toContain(koMessages.activityLog.detailPickRow);
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    const d = detail()!;
    expect(d).toBeTruthy();
    expect(d.closest('aside')).not.toBeNull();                 // the column beside the list
    expect(d.textContent).toContain('story.updated');           // the original action name (was tooltip-only)
    expect(d.querySelector('[data-testid="audit-detail-context"]')?.textContent).toContain('status');
    expect(d.querySelector('[data-testid="audit-detail-context"]')?.textContent).toContain('done');
    expect(d.textContent).toContain('일감 r1');                 // target
    expect(d.textContent).toContain('안나');                    // actor
    expect(container.querySelectorAll('#audit-detail')).toHaveLength(1);
  });

  it('a row without context says so; choosing the same row again closes the details; choosing another moves them', async () => {
    await mount();
    await click(rows()[1]!);
    expect(detail()!.textContent).toContain(koMessages.activityLog.detailNoContext);
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows()[1]!.getAttribute('aria-expanded')).toBe('false');
    expect(detail()!.textContent).toContain('일감 r1');
    await click(rows()[0]!);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false');
    expect(detail()).toBeNull();
  });

  it('⭐narrow: the details open right under the chosen row (not in a side column), once, and the keyboard focus moves into them', async () => {
    mq.wide = false;
    await mount();
    await click(rows()[2]!);
    const d = detail()!;
    expect(d).toBeTruthy();
    expect(d.closest('aside')).toBeNull();
    expect(rows()[2]!.parentElement!.contains(d)).toBe(true);           // inside the same list item, under the row button
    expect(container.querySelectorAll('#audit-detail')).toHaveLength(1);
    expect(document.activeElement).toBe(d);                              // focus continues into the details
    expect(d.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
  });

  it('⭐narrow: closing the details returns the focus to the row that opened them', async () => {
    mq.wide = false;
    await mount();
    await click(rows()[3]!);
    const close = detail()!.querySelector(`button[aria-label="${koMessages.activityLog.detailClose}"]`) as HTMLButtonElement;
    expect(close).toBeTruthy();
    await click(close);
    expect(detail()).toBeNull();
    expect(rows()[3]!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(rows()[3]);
  });
});
