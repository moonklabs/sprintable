// @vitest-environment jsdom
//
// story 5034 (C4) — the three things the PO saw on a phone-width room (dev lap 11-26) · pinned here, measured in a real browser by `e2e/chat-card-states.5034.layout.spec.ts`.
// Red when: the board's five columns stop collapsing to one wrapping line in a narrow card (they broke «착수 / 대기» letter by letter at 214 wide) or stop being a CONTAINER query (the card's own
// width decides, not the screen's) · the board title goes back to two lines (it is one line, the count beside it) · «nothing to show» / «not found» are a title again (bold, big) instead of a supporting line.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { CardFrame } from './card-frame';
import { KanbanCardFace } from './kanban-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function draw(node: React.ReactNode) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
}
const SUMMARY = { title: 'Sprint 12 — Backlog Clearance 처럼 아주 아주 긴 이름의 스프린트', status: 'closed', total: 73, counts: { backlog: 0, 'ready-for-dev': 0, 'in-progress': 0, 'in-review': 0, done: 73 }, now: [], hasMore: false };

describe('the board card in a narrow column', () => {
  it('the five columns are ONE wrapping line until the CARD is wide (a container query), then five boxes', async () => {
    await draw(<KanbanCardFace summary={SUMMARY} />);
    const ul = container.querySelector('[data-testid="chat-card-kanban-columns"]') as HTMLElement;
    expect(ul.className).toMatch(/\bflex\b/); expect(ul.className).toMatch(/flex-wrap/);
    expect(ul.className).toMatch(/@lg:grid\b/); expect(ul.className).toMatch(/@lg:grid-cols-5/);
    expect(ul.parentElement!.className).toMatch(/@container\b/); // the container the query reads is the card's own wrapper — never the screen
    const li = ul.querySelector('li')!;
    expect(li.className).toMatch(/whitespace-nowrap/); // a «label count» pair never breaks inside itself
    expect(ul.querySelectorAll('li').length).toBe(5);
    expect(ul.textContent).toContain('73');
  });
  it('the title is one line (cut with …), the count stays beside it and never wraps', async () => {
    await draw(<KanbanCardFace summary={SUMMARY} />);
    const title = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === SUMMARY.title)!;
    expect(title.className).toMatch(/\btruncate\b/); expect(title.className).not.toMatch(/line-clamp/);
    expect(title.className).toMatch(/min-w-0/); expect(title.className).toMatch(/flex-1/);
    const total = Array.from(container.querySelectorAll('span')).find((s) => s.textContent?.includes('73개'))!;
    expect(total.className).toMatch(/shrink-0/); expect(total.className).toMatch(/whitespace-nowrap/);
  });
});

describe('«nothing to show» and «not found» are quiet', () => {
  it.each([['empty', '보여 줄 내용이 아직 없어요'], ['hidden', '찾을 수 없어요']] as const)('%s is a supporting line, not a title', async (state, line) => {
    await draw(<CardFrame state={state} />);
    const p = Array.from(container.querySelectorAll('p')).find((e) => e.textContent === line)!;
    expect(p).toBeTruthy();
    expect(p.className).toMatch(/text-ds-small/); expect(p.className).toMatch(/text-ds-ink-2/);
    expect(p.className).not.toMatch(/font-(semibold|bold|medium)/); expect(p.className).not.toMatch(/text-ds-card-title/);
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
  });
});

describe('the «this app cannot show this card» card is quiet too', () => {
  it('a card of a kind this build does not know is two supporting lines, not a bold title in a framed empty state', async () => {
    const { UnknownCard } = await import('./card-catalog');
    await draw(<UnknownCard />);
    const ps = Array.from(container.querySelectorAll('[data-testid="chat-card-unknown"] p'));
    expect(ps.map((p) => p.textContent)).toEqual(['이 앱 버전에서는 이 카드를 볼 수 없어요', '앱을 새 버전으로 올리면 보여요']);
    for (const p of ps) { expect(p.className).toMatch(/text-ds-small/); expect(p.className).not.toMatch(/font-(semibold|bold|medium)|text-ds-card-title/); }
    expect(container.querySelector('[data-slot="ds-empty-state"]')).toBeNull();
  });
});
