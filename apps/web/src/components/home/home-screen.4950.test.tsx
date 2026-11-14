// @vitest-environment jsdom
//
// story 4950 (the Mac app's home · PO 11-14): (ⓐ) the button on a «내 손이 필요해요» row only OPENS the request — it says what it does («승인하러 열기» · «결정하러 열기» · «서명하러 열기»), never plain «승인»;
// (ⓑ) such a row has the approvals screen's right-click menu with the entries that need nothing new: open the request · copy its question / title.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { TodaySnapshot } from '../org-briefing/derive-today';
import { deriveHome, type HomeModel } from './derive-home';
import type { HomeSources } from './home-model-provider';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const H = koMessages.home;
const C = koMessages.cage;
const NOW = Date.parse('2026-11-11T12:00:00Z');
let container: HTMLDivElement;
let root: Root;

const need = (over: Record<string, unknown>) => ({
  id: 'g1', source: 'gate', state: 'approval', risk: 'low', workItemType: 'story', workItemId: 's1', workItemTitle: '가입 문구 발행', requestedByName: '글쓰기 에이전트',
  reason: '랜딩 문구 세 가지 비교 결과를 올려요', createdAt: '2026-11-11T09:00:00Z', conversationId: 'c1', conversationProjectId: null, recipePublish: false, projectId: null, ...over,
});
function build(items: unknown[]): { model: HomeModel; sources: HomeSources } {
  const snapshot = { needsMe: items, needsMeCount: items.length, agentProgress: [] } as unknown as TodaySnapshot;
  const model = deriveHome({ snapshot, notifications: [], stories: [], completedToday: [], viewerMemberId: null });
  return { model, sources: { snapshot, notificationHrefById: {}, runConversationById: {} } };
}
const ITEMS = () => build([
  need({ id: 'g1', workItemTitle: '가입 문구 발행', createdAt: '2026-11-11T09:00:00Z' }),
  need({ id: 'd1', workItemType: 'agent_decision', workItemTitle: '랜딩 문구를 가격 먼저로 바꿔도 될까요?', createdAt: '2026-11-11T09:30:00Z' }),
  need({ id: 'g2', state: 'signature', risk: 'high', workItemTitle: 'Threads에 글 발행', reason: null, requestedByName: null, createdAt: '2026-11-11T10:00:00Z', conversationId: null }),
  need({ id: 'g3', state: 'answer', source: 'hitl', workItemTitle: '결제 연결 질문', createdAt: '2026-11-11T11:00:00Z' }),
]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function mount(m: { model: HomeModel; sources: HomeSources }, locale: 'ko' | 'en' = 'ko') {
  const { HomeScreen } = await import('./home-screen');
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><HomeScreen model={m.model} sources={m.sources} /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}
const row = (key: string) => container.querySelector(`[data-row-key="${key}"]`) as HTMLElement;
const actionLink = (key: string) => row(key).querySelector('a[data-home-row-action]') as HTMLAnchorElement;
const rightClick = async (key: string) => { await act(async () => { row(key).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 80 })); }); };
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent?.trim());
const clickMenuItem = async (label: string) => { await act(async () => { ([...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent?.trim() === label) as HTMLElement).click(); }); await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('ⓐ the button says what it does', () => {
  it('⭐an approval row says «승인하러 열기», a decision request «결정하러 열기», a signature «서명하러 열기», a question «답하기» — and NO button on the home says plain «승인» (it only opens the page)', async () => {
    await mount(ITEMS());
    expect(actionLink('gate:g1').textContent).toBe(H.rowApprove); // reverted (the label «승인» again) → RED
    expect(actionLink('gate:d1').textContent).toBe(H.rowDecide);
    expect(actionLink('gate:g2').textContent).toBe(H.rowApproveAndSign);
    expect(actionLink('hitl:g3').textContent).toBe(H.actionAnswer);
    expect(H.rowApprove).not.toBe('승인');
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === '승인')).toBe(false);
    // the detail card's button wears the same words as the row's
    expect(container.querySelector('[data-testid="home-detail-actions"] a')!.textContent).toBe(H.rowApprove);
  });

  it('the words in English: «Open to approve» · «Open to decide» · «Open to sign»', async () => {
    await mount(ITEMS(), 'en');
    expect(actionLink('gate:g1').textContent).toBe(enMessages.home.rowApprove);
    expect(actionLink('gate:d1').textContent).toBe(enMessages.home.rowDecide);
    expect(actionLink('gate:g2').textContent).toBe(enMessages.home.rowApproveAndSign);
    expect([enMessages.home.rowApprove, enMessages.home.rowDecide, enMessages.home.rowApproveAndSign].every((w) => /^Open to /.test(w))).toBe(true);
  });
});

describe('① the detail column of an all-clear home', () => {
  it('draws NOTHING in the wide detail column (no repeated sentence) and the empty column is hidden so it is not an empty landmark', async () => {
    await mount(build([]));
    const col = container.querySelector('[data-testid="home-detail-column"]') as HTMLElement;
    expect(col.childElementCount).toBe(0); // reverted (the old repeated card) → a card is drawn in it
    expect(col.className).toContain('empty:hidden'); // an empty aside with a label would be an empty landmark for a screen reader
    expect(container.textContent!.split(H.emptyAllTitle).length - 1).toBe(1);
  });
});

describe('ⓑ the right-click menu of a «내 손이 필요해요» row', () => {
  it('⭐right-click → «자세히 열기» · «질문 복사»(a decision) / «제목 복사»(any other) — the approvals screen\'s own words', async () => {
    await mount(ITEMS());
    await rightClick('gate:g1');
    expect(menuLabels()).toEqual([C.queueMenuOpen, C.queueMenuCopyTitle]); // reverted (no menu) → []
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await rightClick('gate:d1');
    expect(menuLabels()).toEqual([C.queueMenuOpen, C.queueMenuCopyQuestion]);
  });

  it('«복사» copies THAT row\'s title and changes nothing else; «자세히 열기» goes where the row\'s own button goes', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount(ITEMS());
    await rightClick('gate:d1');
    await clickMenuItem(C.queueMenuCopyQuestion);
    expect(writeText).toHaveBeenLastCalledWith('랜딩 문구를 가격 먼저로 바꿔도 될까요?');
    await rightClick('gate:g2');
    const link = actionLink('gate:g2'); const clicked = vi.fn((e: Event) => e.preventDefault()); link.addEventListener('click', clicked);
    await clickMenuItem(C.queueMenuOpen);
    expect(clicked).toHaveBeenCalledTimes(1); // the menu's «open» IS a click on the row's own link (client-side navigation, nothing new)
  });

  it('a row that is not «내 손이 필요해요» (working · just finished) has no menu of its own', async () => {
    const snapshot = { needsMe: [], needsMeCount: 0, agentProgress: [{ runId: 'r1', agentName: '댄', status: 'running', title: '결제 연결', startedAt: '2026-11-11T11:00:00Z' }] } as unknown as TodaySnapshot;
    const model = deriveHome({ snapshot, notifications: [], stories: [], completedToday: [], viewerMemberId: null });
    await mount({ model, sources: { snapshot, notificationHrefById: {}, runConversationById: {} } });
    const anyRow = container.querySelector('[data-row-key^="run:"], [data-row-key^="agent-run"]') as HTMLElement | null;
    if (anyRow) { await act(async () => { anyRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })); }); }
    expect(menuLabels()).toEqual([]);
  });
});
