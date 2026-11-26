// @vitest-environment jsdom
//
// story 5034 (C4) — the state toggle: every state of a chat card reachable from ONE place, and the two widths. Red when: a state of the six cannot be shown · the toggle stops saying which is on ·
// the width toggle stops changing the stage · a long title makes the card wider than its stage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { CardStatesShowcase, SHOWCASE_WIDTHS } from './card-states-showcase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({ projectMemberships: [] }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><CardStatesShowcase /></NextIntlClientProvider>); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const btn = (label: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)!;
const stage = () => container.querySelector('[data-testid="chat-card-states-stage"]') as HTMLElement;
const state = () => container.querySelector('[data-card-state]')!.getAttribute('data-card-state');
const state_ = state; // (used inside the per-kind loop above)

const fetchSpy = vi.fn();
beforeEach(() => { fetchSpy.mockReset(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('every kind of card has its states in the showcase (PO: «카드마다 상태 토글» — the board · the membership card · the refused card were missing)', () => {
  const KINDS = [['객체', 'entity'], ['칸반', 'kanban'], ['프로젝트 소속', 'deploy'], ['거절', 'refused']] as const;
  const kindOn = () => stage().getAttribute('data-card-kind');
  it('four kinds are reachable, the toggle says which is on, and the stage tells which card it draws', async () => {
    expect(kindOn()).toBe('entity'); expect(btn('객체').getAttribute('aria-pressed')).toBe('true');
    for (const [label, want] of KINDS) {
      await act(async () => { btn(label).click(); });
      expect(kindOn()).toBe(want); expect(btn(label).getAttribute('aria-pressed')).toBe('true');
    }
  });
  it.each(KINDS)('%s: all six states can be shown (loading · empty · error · not visible are the shared frame, default and long are the kind\'s own face)', async (label, kind) => {
    await act(async () => { btn(label).click(); });
    for (const [state, want] of [['로딩', 'loading'], ['비어 있음', 'empty'], ['오류', 'error'], ['볼 수 없음', 'hidden'], ['긴 글', 'ready'], ['기본', 'ready']] as const) {
      await act(async () => { btn(state).click(); });
      expect(state_(), `${kind} ${state}`).toBe(want);
    }
  });
  it('the board draws its five columns and the count; the long state is a one-line title with the count beside it', async () => {
    await act(async () => { btn('칸반').click(); });
    expect(container.querySelectorAll('[data-column]').length).toBe(5); expect(container.textContent).toContain('장 73개');
    await act(async () => { btn('긴 글').click(); });
    const title = Array.from(container.querySelectorAll('span')).find((e) => e.className.includes('truncate'))!;
    expect(title.textContent!.length).toBeGreaterThan(100);
  });
  it('the membership card: «빼기» asks first, then «넣기» comes back — on a local stand-in that writes NOTHING (no fetch)', async () => {
    await act(async () => { btn('프로젝트 소속').click(); });
    expect(container.textContent).toContain('이 프로젝트에 들어 있어요');
    await act(async () => { btn('이 프로젝트에서 빼기').click(); });
    expect(container.textContent).toContain('뺄까요');
    await act(async () => { btn('빼기').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('이 프로젝트에 들어 있지 않아요');
    await act(async () => { btn('이 프로젝트에 넣기').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('이 프로젝트에 들어 있어요');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('the membership card follows the toggle: «긴 글» gives the long name and «기본» the short one again — while the card stays on screen (PO, dev 11-26: it stayed as first drawn)', async () => {
    await act(async () => { btn('프로젝트 소속').click(); });
    expect(container.textContent).toContain('오르테가'); expect(container.textContent).not.toContain('아주 긴 제목이');
    await act(async () => { btn('긴 글').click(); });
    expect(container.textContent).toContain('아주 긴 제목이'); expect(container.textContent).not.toContain('오르테가');
    await act(async () => { btn('기본').click(); });
    expect(container.textContent).toContain('오르테가'); expect(container.textContent).not.toContain('아주 긴 제목이');
    // and the other way: arriving from «긴 글» shows the long name, «기본» then the short one
    await act(async () => { btn('객체').click(); });
    await act(async () => { btn('긴 글').click(); });
    await act(async () => { btn('프로젝트 소속').click(); });
    expect(container.textContent).toContain('아주 긴 제목이');
    await act(async () => { btn('기본').click(); });
    expect(container.textContent).toContain('오르테가'); expect(container.textContent).not.toContain('아주 긴 제목이');
  });
  it('what the two buttons changed is kept when the name toggles (a press is not forgotten by «긴 글»)', async () => {
    await act(async () => { btn('프로젝트 소속').click(); });
    await act(async () => { btn('이 프로젝트에서 빼기').click(); });
    await act(async () => { btn('빼기').click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    await act(async () => { btn('긴 글').click(); });
    expect(container.textContent).toContain('이 프로젝트에 들어 있지 않아요');
  });
  it('the refused card (what a viewer who CAN read the object sees) names the agent and who can see it; «볼 수 없음» is the plain «찾을 수 없어요» line (what everyone else sees)', async () => {
    await act(async () => { btn('거절').click(); });
    expect(container.textContent).toContain('보여 주려던 에이전트'); expect(container.textContent).toContain('볼 수 있는 에이전트');
    await act(async () => { btn('볼 수 없음').click(); });
    expect(stage().textContent).toBe('찾을 수 없어요');
  });
  it('nothing in the showcase reads the server', async () => {
    for (const [label] of KINDS) { await act(async () => { btn(label).click(); }); }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('chat card state toggle', () => {
  it('starts at «기본» (ready) and each of the six states can be shown, with the toggle saying which one is on', async () => {
    expect(state()).toBe('ready'); expect(btn('기본').getAttribute('aria-pressed')).toBe('true');
    for (const [label, want] of [['로딩', 'loading'], ['비어 있음', 'empty'], ['오류', 'error'], ['볼 수 없음', 'hidden'], ['긴 글', 'ready'], ['기본', 'ready']] as const) {
      await act(async () => { btn(label).click(); });
      expect(state()).toBe(want);
      expect(btn(label).getAttribute('aria-pressed')).toBe('true');
    }
  });
  it('the long text is the SAME ready card with a long title — wrapped in two lines inside its stage, never wider than it', async () => {
    await act(async () => { btn('긴 글').click(); });
    const title = Array.from(container.querySelectorAll('span')).find((s) => s.className.includes('line-clamp-2'))!;
    expect(title.textContent!.length).toBeGreaterThan(100);
    expect(title.className).toContain('break-words');
    expect(container.querySelector('[data-card-state]')!.className).toContain('max-w-full');
  });
  it('the error state offers «다시 시도» and pressing it goes back to the default card', async () => {
    await act(async () => { btn('오류').click(); });
    await act(async () => { btn('다시 시도').click(); });
    expect(state()).toBe('ready');
  });
  it('390 and 1440: the stage takes the phone width or the desktop width (and never more than its column)', async () => {
    expect(stage().style.width).toBe(`${SHOWCASE_WIDTHS.narrow}px`);
    await act(async () => { btn('1440 폭').click(); });
    expect(stage().style.width).toBe(`${SHOWCASE_WIDTHS.wide}px`); expect(stage().style.maxWidth).toBe('100%');
    expect(btn('1440 폭').getAttribute('aria-pressed')).toBe('true'); expect(btn('390 폭').getAttribute('aria-pressed')).toBe('false');
  });
});
