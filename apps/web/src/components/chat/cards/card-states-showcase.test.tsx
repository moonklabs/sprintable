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
