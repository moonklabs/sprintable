// @vitest-environment jsdom
//
// story 4892 (UI-9 활동 §2) — the team feed is grouped by DAY in the viewer's zone (오늘 · 어제 · the date), like the audit log; each day is its own list, the rows
// are unchanged (actor · verb · object link · seq · time · delivered count), «더 보기» / the end line sit after the last day, and a 403 / empty / error keeps its own state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TeamActivityView } from './team-activity-view';
import { TopBarProvider } from '@/components/nav/top-bar-context';
import koMessages from '../../../messages/ko.json';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args) }));
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));
// the viewer's zone decides which day a row is on — pin it so the test does not depend on the machine's zone
const viewerZone = vi.hoisted(() => ({ value: 'UTC' as string | null }));
vi.mock('@/components/viewer-time-zone', () => ({ useViewerTimeZone: () => viewerZone.value }));
import { resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const NOW = new Date('2026-11-10T12:00:00Z');
const item = (seq: number, occurred_at: string, over: Record<string, unknown> = {}) => ({
  activity_id: `a${seq}`, project_id: 'p1', actor_id: null, verb: 'updated', object_type: 'doc', object_id: `d${seq}`, object_title: `문서 ${seq}`,
  occurred_at, source_event_ids: [], recipient_ids: seq % 2 ? ['m1', 'm2'] : [], recipient_types: [], payload: {}, activity_seq: seq, ...over,
});
type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (ok: boolean, status: number, data?: unknown): Answer => ({ ok, status, json: async () => ({ data }) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  document.documentElement.lang = 'ko';   // this view reads its locale from the document (jsdom has none)
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  resetOrgMembersCacheForTests();
  viewerZone.value = 'UTC';
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  document.documentElement.lang = '';
  vi.useRealTimers();
});

async function mount(items: unknown[], extra: Record<string, unknown> = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('/api/members')) return answer(true, 200, []);
    if (url.includes('/api/activity-stream')) return answer(true, 200, { items, next_after_seq: null, next_before_seq: null, ...extra });
    return answer(false, 404);
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
        <TopBarProvider><TeamActivityView projectId="p1" /></TopBarProvider>
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const groups = () => [...container.querySelectorAll('[data-testid="feed-day-group"]')] as HTMLElement[];

describe('TeamActivityView — 일 단위 묶음 (4892)', () => {
  const ITEMS = [item(5, '2026-11-10T09:00:00Z'), item(4, '2026-11-10T01:00:00Z'), item(3, '2026-11-09T20:00:00Z'), item(2, '2026-11-02T10:00:00Z')];

  it('⭐rows sit under day headers — 오늘 · 어제 · the date — in the order the server sent them', async () => {
    await mount(ITEMS);
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', '어제', expect.stringContaining('11월')]);
    expect(groups().map((g) => [...g.querySelectorAll('li')].map((li) => li.textContent?.match(/#(\d+)/)?.[1]))).toEqual([['5', '4'], ['3'], ['2']]);
  });

  it('each day is its own list; the rows keep their object link and the delivered count', async () => {
    await mount(ITEMS);
    expect(groups().every((g) => g.querySelectorAll('ul').length === 1)).toBe(true);
    const first = groups()[0]!;
    expect(first.querySelector('a')?.getAttribute('href')).toContain('d5');
    expect(first.textContent).toContain('◎');                      // item 5 has recipients
  });

  it('«더 보기» and the end line stay after the last day (not inside a day)', async () => {
    await mount(ITEMS, { next_before_seq: 2 });
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.teamActivity.loadMore);
    expect(more).toBeTruthy();
    expect(groups().length).toBe(3);
    expect(groups().some((g) => g.contains(more!))).toBe(false);
    expect(more!.compareDocumentPosition(groups()[2]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();   // the button follows the last day
  });

  it('the end line (no more pages) also sits after the last day, not inside one', async () => {
    await mount(ITEMS);
    const end = [...container.querySelectorAll('li')].find((li) => li.textContent === koMessages.teamActivity.endOfAll || li.textContent === koMessages.teamActivity.endOfRange);   // which one depends on whether the default range has a start date
    expect(end).toBeTruthy();
    expect(groups().length).toBe(3);
    expect(groups().some((g) => g.contains(end!))).toBe(false);
    expect(end!.compareDocumentPosition(groups()[2]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('a null time is «날짜 모름» with a dash — not 1970 and not an exception', async () => {
    await mount([item(5, '2026-11-10T09:00:00Z'), item(4, null as unknown as string)]);
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', koMessages.activityLog.dayUndated]);
    expect(groups()[1]!.textContent).toContain('—');
    expect(container.textContent).not.toMatch(/1970|50년|56년/);
  });

  it("the day is the viewer's day: 20:00Z on the 9th is already «오늘» (the 10th) in Seoul, but «어제» in UTC", async () => {
    viewerZone.value = 'Asia/Seoul';
    await mount([item(3, '2026-11-09T20:00:00Z')]);
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘']);
  });

  it('a viewer whose zone is not known yet falls back to UTC (no crash, still grouped)', async () => {
    viewerZone.value = null;
    await mount([item(3, '2026-11-09T20:00:00Z')]);
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['어제']);
  });

  it('each day section is named by its own header (a landmark a screen reader can list)', async () => {
    await mount(ITEMS);
    expect(groups().length).toBe(3);
    expect(groups().map((g) => g.getAttribute('aria-label'))).toEqual(groups().map((g) => g.querySelector('h2')?.textContent));
    expect(groups().every((g) => !!g.getAttribute('aria-label'))).toBe(true);
  });

  it('⭐a row whose time is empty or broken is shown in a last «날짜 모름» group — the feed does not crash and the row is not lost', async () => {
    await mount([item(5, '2026-11-10T09:00:00Z'), item(4, ''), item(3, 'not-a-date')]);
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', koMessages.activityLog.dayUndated]);
    expect(groups().map((g) => [...g.querySelectorAll('li')].map((li) => li.textContent?.match(/#(\d+)/)?.[1]))).toEqual([['5'], ['4', '3']]);
  });

  it('«더 보기» adds the next page: a row of a day already shown joins that day (one header), an older day gets its own', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/members')) return answer(true, 200, []);
      if (url.includes('before_seq')) return answer(true, 200, { items: [item(3, '2026-11-10T02:00:00Z'), item(2, '2026-11-02T10:00:00Z')], next_after_seq: null, next_before_seq: null });
      return answer(true, 200, { items: [item(5, '2026-11-10T09:00:00Z'), item(4, '2026-11-10T08:00:00Z')], next_after_seq: null, next_before_seq: 4 });
    });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">
          <TopBarProvider><TeamActivityView projectId="p1" /></TopBarProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === koMessages.teamActivity.loadMore)!;
    await act(async () => { more.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(groups().map((g) => g.querySelector('h2')?.textContent)).toEqual(['오늘', expect.stringContaining('11월')]);
    expect(groups().map((g) => [...g.querySelectorAll('li')].map((li) => li.textContent?.match(/#(\d+)/)?.[1]))).toEqual([['5', '4', '3'], ['2']]);
  });

  it('a real empty answer is still the empty state — no day header', async () => {
    await mount([]);
    expect(groups()).toHaveLength(0);
    expect(container.textContent).toContain(koMessages.teamActivity.emptyTitle);
  });
});
