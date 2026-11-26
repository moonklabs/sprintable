// @vitest-environment jsdom
//
// story 5034 (C4) — the chat card catalogue and its entity card, with the viewer's own reads stubbed at fetch. Red when: a kind has no decision in the catalogue · a kind this build cannot draw
// becomes a blank hole or a guess · «not found» and «not yours» stop looking the same · a network fault loses its «try again» · the card reads anything but the viewer's own session ·
// the click stops opening the side panel with the right target · a long title widens the card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ReadingPanelProvider, type ReadingPanelContextValue } from '../reading-panel-context';
import { CARD_PARTS, ChatCard } from './card-catalog';
import { CARD_KINDS } from './card-kinds';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectMemberships: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (h: string) => h }));

const ID = '0d6e953f-6d43-42c1-a87c-b023544497db';
let container: HTMLDivElement;
let root: Root;
let calls: string[];

function json(status: number, body: unknown = {}): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function stubFetch(answer: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { const url = String(input); calls.push(url); return answer(url); }));
}
async function show(card: unknown, panel: ReadingPanelContextValue | null = null) {
  await act(async () => { root.render(null); }); // a fresh card every time (the same element would keep its first read — the effect would not run again)
  const tree = (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {panel ? <ReadingPanelProvider value={panel}><ChatCard card={card} /></ReadingPanelProvider> : <ChatCard card={card} />}
    </NextIntlClientProvider>
  );
  await act(async () => { root.render(tree); });
  await act(async () => { await Promise.resolve(); });
}
const frame = () => container.querySelector('[data-card-state]') as HTMLElement | null;

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); calls = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('catalogue', () => {
  it('every kind of the closed vocabulary has a decision — a part or an explicit «none» (a kind cannot be forgotten)', () => {
    expect(Object.keys(CARD_PARTS).sort()).toEqual([...CARD_KINDS].sort());
    const none = CARD_KINDS.filter((k) => CARD_PARTS[k] === null);
    expect(none.sort()).toEqual(['deploy', 'gate']); // deploy comes with the next step of the story (gate = the approval card's own road)
  });
  it.each([
    ['an unknown kind', { kind: 'timeline', ref: ID }],
    ['a reference that is not a UUID', { kind: 'story', ref: 'nope' }],
    ['a kind with no part in this build yet (deploy)', { kind: 'deploy', ref: ID }],
    ['a gate (drawn by the approval card\'s own road)', { kind: 'gate', ref: ID }],
    ['something that is not a card at all', 'story'],
  ])('%s → the «this app version cannot show it» card, and NOTHING is read from the server', async (_n, card) => {
    stubFetch(() => json(200, {}));
    await show(card);
    expect(container.querySelector('[data-testid="chat-card-unknown"]')).not.toBeNull();
    expect(container.textContent).toContain('이 앱 버전에서는 이 카드를 볼 수 없어요');
    expect(calls).toEqual([]);
  });
});

describe('entity card — read for the viewer', () => {
  it('shows «loading» first, then the title and the status the server gave THIS viewer (their own session\'s read · one request)', async () => {
    let release!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => { release = r; }));
    await show({ kind: 'story', ref: ID });
    expect(frame()!.dataset.cardState).toBe('loading');
    await act(async () => { release(json(200, { data: { title: '결제 화면 고치기', status: 'in-progress' } })); });
    await act(async () => { await Promise.resolve(); });
    expect(frame()!.dataset.cardState).toBe('ready');
    expect(container.textContent).toContain('결제 화면 고치기');
    expect(calls).toEqual([`/api/stories/${ID}`]);
  });
  it('«not found» (404) and «not yours» (403) look EXACTLY the same — and offer no «try again»', async () => {
    const seen: string[] = [];
    for (const status of [404, 403]) {
      stubFetch(() => json(status, { error: 'x' }));
      await show({ kind: 'story', ref: ID });
      seen.push(container.innerHTML);
      expect(frame()!.dataset.cardState).toBe('hidden');
      expect(container.textContent).toContain('찾을 수 없어요');
      expect(container.querySelector('button')).toBeNull();
    }
    expect(seen[0]).toBe(seen[1]);
  });
  it('a server fault (5xx) is «error» with «다시 시도» — pressing it reads again and shows the card when it works', async () => {
    let n = 0;
    stubFetch(() => (++n === 1 ? json(503) : json(200, { data: { title: '다시 불러온 장' } })));
    await show({ kind: 'story', ref: ID });
    expect(frame()!.dataset.cardState).toBe('error');
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('다시 시도'))!;
    await act(async () => { retry.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(frame()!.dataset.cardState).toBe('ready');
    expect(container.textContent).toContain('다시 불러온 장');
    expect(calls.length).toBe(2);
  });
  it('a doc is read through the doc preview (the id is not a slug) · an epic through the goals read', async () => {
    stubFetch(() => json(200, { data: { title: '문서 제목' } }));
    await show({ kind: 'doc', ref: ID });
    expect(calls).toEqual([`/api/docs/preview?q=${ID}`]);
    expect(container.textContent).toContain('문서 제목');
    calls.length = 0;
    stubFetch(() => json(200, { data: { name: '목표 이름' } }));
    await show({ kind: 'epic', ref: ID });
    expect(calls).toEqual([`/api/goals/${ID}`]);
    expect(container.textContent).toContain('목표 이름');
  });
  it('the click opens the SIDE PANEL (the second tier) with this object as the target · no panel around = no button, just the card', async () => {
    stubFetch(() => json(200, { data: { title: '열 장', status: 'done' } }));
    const open = vi.fn();
    await show({ kind: 'story', ref: ID }, { open, close: () => {}, navigateTo: () => {} });
    const btn = container.querySelector('button')!;
    expect(btn.getAttribute('aria-label')).toContain('옆 패널에서 열기');
    await act(async () => { btn.click(); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toMatchObject({ kind: 'entity', entityType: 'story', entityId: ID, title: '열 장', status: 'done' });
    await show({ kind: 'story', ref: ID }, null);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('열 장');
  });
  it('a long title wraps inside the card: two lines then cut, the card never wider than its column', async () => {
    stubFetch(() => json(200, { data: { title: '아주아주 긴 제목 '.repeat(40) } }));
    await show({ kind: 'story', ref: ID });
    const title = Array.from(container.querySelectorAll('span')).find((s) => s.textContent?.includes('아주아주'))!;
    expect(title.className).toMatch(/line-clamp-2/); expect(title.className).toMatch(/break-words/); expect(title.className).toMatch(/min-w-0/);
    expect(frame()!.className).toMatch(/max-w-full/); expect(frame()!.className).toMatch(/min-w-0/);
  });
  it('no title in the answer → the card still draws (the reference stands in — never an empty line)', async () => {
    stubFetch(() => json(200, { data: { status: 'done' } }));
    await show({ kind: 'task', ref: ID });
    expect(frame()!.dataset.cardState).toBe('ready');
    expect(container.textContent).toContain(ID);
  });
});
