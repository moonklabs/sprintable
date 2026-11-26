// @vitest-environment jsdom
//
// story 5034 (C4 step 3) — the sprint board card, with the viewer's own reads stubbed at fetch. Red when: a column's count is wrong or a story of an unknown status is counted · more than three
// «being worked on» titles are listed · the card reads anything but the sprint and its stories · «not found» and «not yours» stop looking the same · a body of another shape is drawn as a board ·
// a board with more stories than one page claims a wrong total · the press stops opening the SPRINT in the side panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ReadingPanelProvider } from '../reading-panel-context';
import { ChatCard } from './card-catalog';
import { KANBAN_NOW_MAX, KANBAN_PAGE } from './kanban-summary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectMemberships: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const SPRINT = '0d6e953f-6d43-42c1-a87c-b023544497db';
let container: HTMLDivElement;
let root: Root;
let calls: string[];

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const story = (i: number, status: string, title = `장 ${i}`) => ({ id: `id-${i}`, story_number: 100 + i, title, status });
function stub(opts: { sprint?: Response; stories?: Response } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.startsWith('/api/sprints/')) return (opts.sprint ?? json(200, { data: { name: '11월 스프린트', status: 'active' } })).clone();
    return (opts.stories ?? json(200, { data: [] })).clone();
  }));
}
async function show(panel: { open: (t: unknown) => void } | null = null) {
  await act(async () => { root.render(null); });
  const card = <ChatCard card={{ kind: 'kanban', ref: SPRINT }} />;
  const tree = (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {panel ? <ReadingPanelProvider value={{ open: panel.open as never, close: () => {}, navigateTo: () => {} }}>{card}</ReadingPanelProvider> : card}
    </NextIntlClientProvider>
  );
  await act(async () => { root.render(tree); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}
const frame = () => container.querySelector('[data-card-state]') as HTMLElement | null;
const count = (col: string) => container.querySelector(`[data-column="${col}"] span:last-child`)!.textContent;

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); calls = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('sprint board card', () => {
  it('reads the sprint and its stories (the viewer\'s own two reads, nothing else) and counts every column; a story of an unknown status is not counted', async () => {
    stub({ stories: json(200, { data: [story(1, 'backlog'), story(2, 'backlog'), story(3, 'ready-for-dev'), story(4, 'in-progress'), story(5, 'in-review'), story(6, 'done'), story(7, 'done'), story(8, 'done'), story(9, 'archived-by-a-newer-server')] }) });
    await show();
    expect(calls.sort()).toEqual([`/api/sprints/${SPRINT}`, `/api/stories?sprint_id=${SPRINT}&limit=${KANBAN_PAGE}`].sort());
    expect(frame()!.dataset.cardState).toBe('ready');
    expect(container.textContent).toContain('11월 스프린트');
    expect([count('backlog'), count('ready-for-dev'), count('in-progress'), count('in-review'), count('done')]).toEqual(['2', '1', '1', '1', '3']);
    expect(container.textContent).toContain('장 8개'); // 8 of the five columns — the unknown one is not in the total
    expect(Array.from(container.querySelectorAll('[data-column]')).map((e) => (e as HTMLElement).dataset.column)).toEqual(['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done']); // the board reads left to right as the work flows
  });
  it('lists at most three of the stories being worked on (in progress or in review), with their numbers — and none from the other columns', async () => {
    const rows = [story(1, 'backlog', '대기 장'), story(2, 'in-progress', '하나'), story(3, 'in-review', '둘'), story(4, 'in-progress', '셋'), story(5, 'in-progress', '넷'), story(6, 'done', '끝난 장')];
    stub({ stories: json(200, { data: rows }) });
    await show();
    const now = container.querySelector('[data-testid="chat-card-kanban-now"]')!;
    const titles = Array.from(now.querySelectorAll('span.truncate')).map((s) => s.textContent);
    expect(titles).toEqual(['하나', '둘', '셋']); expect(titles.length).toBe(KANBAN_NOW_MAX);
    expect(now.textContent).toContain('102');
    expect(now.textContent).not.toContain('대기 장'); expect(now.textContent).not.toContain('끝난 장');
  });
  it('no story in the sprint → the empty card · no work in progress → no «지금 하는 장» block', async () => {
    stub({ stories: json(200, { data: [] }) });
    await show();
    expect(frame()!.dataset.cardState).toBe('empty');
    stub({ stories: json(200, { data: [story(1, 'backlog'), story(2, 'done')] }) });
    await show();
    expect(frame()!.dataset.cardState).toBe('ready');
    expect(container.querySelector('[data-testid="chat-card-kanban-now"]')).toBeNull();
  });
  it('a board with more than one page says so (the total is shown with «+»), never a wrong exact number', async () => {
    stub({ stories: json(200, { data: [story(1, 'backlog')], meta: { limit: KANBAN_PAGE, hasMore: true, nextCursor: 'x' } }) });
    await show();
    expect(container.textContent).toContain('장 1개+');
  });
  it('«not found» of the sprint (404) · «not yours» of its stories (403) look EXACTLY the same, with no «try again»', async () => {
    const seen: string[] = [];
    for (const o of [{ sprint: json(404) }, { stories: json(403) }]) {
      stub(o); await show();
      seen.push(container.innerHTML);
      expect(frame()!.dataset.cardState).toBe('hidden');
      expect(container.textContent).toContain('찾을 수 없어요');
      expect(container.querySelector('button')).toBeNull();
    }
    expect(seen[0]).toBe(seen[1]);
  });
  it('a server fault is «error» with «다시 시도»; a body that is not `{ data }` is the same fault, never a board', async () => {
    stub({ stories: json(503) });
    await show();
    expect(frame()!.dataset.cardState).toBe('error');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('다시 시도'))).toBe(true);
    stub({ stories: json(200, [story(1, 'done')]) });
    await show();
    expect(frame()!.dataset.cardState).toBe('error');
    stub({ sprint: json(200, { name: 'x' }) });
    await show();
    expect(frame()!.dataset.cardState).toBe('error');
  });
  it('pressing the head opens THE SPRINT in the side panel (the second tier) · no panel around = no button', async () => {
    stub({ stories: json(200, { data: [story(1, 'done')] }) });
    const open = vi.fn();
    await show({ open });
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toContain('옆 패널에서 열기');
    await act(async () => { btn.click(); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ kind: 'entity', entityType: 'sprint', entityId: SPRINT, title: '11월 스프린트', status: 'active' });
    await show(null);
    expect(container.querySelector('button')).toBeNull();
  });
});
