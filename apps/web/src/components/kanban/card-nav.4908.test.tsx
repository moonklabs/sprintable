// @vitest-environment jsdom
//
// 4908 넷째 조각 — 방향키로 카드 사이 초점 이동(끌고 있지 않을 때). ↑↓ = 같은 열의 이웃 카드 · ←→ = 이웃 열(카드 없는 열 · 띠는 건너뜀)의 같은 자리(더 짧으면 마지막).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { StoryCard } from './story-card';
import { moveCardFocus } from './card-nav';
import type { KanbanStory } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 열 셋: A(카드 3) · B(카드 없음 — 띠) · C(카드 1). 카드는 초점을 받을 수 있게 tabindex를 준다. */
function board() {
  document.body.innerHTML = `
    <div id="row">
      <div data-board-column="a"><div data-story-card tabindex="0" id="a1"></div><div data-story-card tabindex="0" id="a2"></div><div data-story-card tabindex="0" id="a3"></div></div>
      <div data-board-column="b"></div>
      <div data-board-column="c"><div data-story-card tabindex="0" id="c1"></div></div>
    </div>`;
  return (id: string) => document.getElementById(id) as HTMLElement;
}
afterEach(() => { document.body.innerHTML = ''; });

describe('moveCardFocus — 화면 순서대로', () => {
  it('⭐↓↑: 같은 열의 이웃 카드 · 열 끝에서는 안 움직인다(false)', () => {
    const $ = board();
    expect(moveCardFocus($('a1'), 'ArrowDown')).toBe(true);
    expect(document.activeElement).toBe($('a2'));
    expect(moveCardFocus($('a2'), 'ArrowUp')).toBe(true);
    expect(document.activeElement).toBe($('a1'));
    expect(moveCardFocus($('a1'), 'ArrowUp')).toBe(false);
    expect(moveCardFocus($('a3'), 'ArrowDown')).toBe(false);
  });

  it('⭐→←: 카드 없는 열(띠)을 건너뛰어 이웃 열의 같은 자리로 · 그 열이 더 짧으면 마지막 카드', () => {
    const $ = board();
    expect(moveCardFocus($('a3'), 'ArrowRight')).toBe(true);
    expect(document.activeElement).toBe($('c1')); // 가운데 빈 열을 건너뜀 · 자리 2가 없으니 마지막
    expect(moveCardFocus($('c1'), 'ArrowLeft')).toBe(true);
    expect(document.activeElement).toBe($('a1')); // 자리 0
    expect(moveCardFocus($('c1'), 'ArrowRight')).toBe(false); // 더 오른쪽 열이 없다
  });

  it('열에 속하지 않은 카드 · 방향키가 아닌 키는 아무것도 안 한다', () => {
    const $ = board();
    expect(moveCardFocus($('a1'), 'Enter')).toBe(false);
    const loose = document.createElement('div'); loose.setAttribute('data-story-card', ''); document.body.appendChild(loose);
    expect(moveCardFocus(loose, 'ArrowDown')).toBe(false);
  });
});

describe('StoryCard의 방향키', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => { root.unmount(); }); container.remove(); });
  const make = (id: string, title: string) => ({ id, title, status: 'in-progress', priority: 'medium', story_points: null, assignee_id: null, epic_id: null, assignee_ids: [] }) as unknown as KanbanStory;
  const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });

  function mountTwo(props: Partial<React.ComponentProps<typeof StoryCard>> = {}) {
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DndContext>
            <div data-board-column="x">
              <StoryCard story={make('s1', '첫째')} onClick={() => {}} {...props} />
              <StoryCard story={make('s2', '둘째')} onClick={() => {}} {...props} />
            </div>
          </DndContext>
        </NextIntlClientProvider>,
      );
    });
    return [...container.querySelectorAll<HTMLElement>('[data-story-card]')];
  }

  it('⭐카드에서 ↓를 누르면 다음 카드로 초점이 간다(preventDefault — 화면이 같이 스크롤되지 않는다)', () => {
    const [first, second] = mountTwo();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    act(() => { first!.dispatchEvent(ev); });
    expect(document.activeElement).toBe(second);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('수정키와 같이 누른 방향키 · 카드 안 입력칸의 방향키는 가로채지 않는다', () => {
    const [first, second] = mountTwo({ onRename: vi.fn() });
    key(first!, 'ArrowDown', { shiftKey: true });
    key(first!, 'ArrowDown', { ctrlKey: true });
    expect(document.activeElement).not.toBe(second);
    key(first!, 'F2');
    const input = first!.querySelector('input')!;
    key(input, 'ArrowDown');
    expect(document.activeElement).not.toBe(second);
  });
});
