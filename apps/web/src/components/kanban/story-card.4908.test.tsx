// @vitest-environment jsdom
//
// 4908 — 보드 카드 재건축 구조 가드. 카드 = 글 줄 층(rowOthers) · 열린 카드 = 열린 카드 층 + 왼쪽 막대 · 3줄(머리 · 제목 · 메타) · «⋯» 버튼은 이름에 카드 제목을 달고 우클릭과 같은 메뉴를 연다 ·
// kickoff(예전 호버 로켓)는 그 메뉴 안으로 옮겨 갔다 · 상태 글은 «열이 상태를 말해 주지 않는 자리»에서만 보인다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import koMessages from '../../../messages/ko.json';
import { LAYER } from '@/components/ds/layers';
import { StoryCard } from './story-card';
import type { KanbanStory } from './types';

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 4908, title: '보드 재건축', status: 'in-progress', priority: 'medium',
    story_points: 3, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof StoryCard>> = {}) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <DndContext>
          <StoryCard story={makeStory()} onClick={() => {}} projectId="p1" onChangeStatus={() => {}} {...props} />
        </DndContext>
      </NextIntlClientProvider>,
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe('4908 카드 — 층 · 선택 표시', () => {
  it('⭐카드는 글 줄 층(LAYER.rowOthers)이고 열린 카드 표시가 없다', () => {
    const card = render();
    expect(card.className).toContain(LAYER.rowOthers);
    expect(card.className).not.toContain(LAYER.rowSelected);
    expect(card.getAttribute('aria-current')).toBeNull();
    expect(card.querySelector('[data-testid="story-card-selected-bar"]')).toBeNull();
  });

  it('⭐열린 카드는 열린 카드 층(LAYER.rowSelected) + 왼쪽 막대 + aria-current — 면만으로 가르지 않는다(면 밝기 차이가 글 줄과 거의 같아서)', () => {
    const card = render({ selected: true });
    expect(card.className).toContain(LAYER.rowSelected);
    expect(card.className).not.toContain(LAYER.rowOthers);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(card.querySelector('[data-testid="story-card-selected-bar"]')).not.toBeNull();
  });
});

describe('4908 카드 — 줄 구성', () => {
  it('상태 글은 showStatus일 때만 — 열이 곧 상태인 자리에서는 같은 것을 두 자리에 안 보인다', () => {
    expect(render().textContent).not.toContain(koMessages.board.inProgress);
    expect(render({ showStatus: true }).textContent).toContain(koMessages.board.inProgress);
  });

  it('제목은 2줄까지(line-clamp-2) · 메타 줄은 늘 서 있다(min-h-5)', () => {
    const card = render();
    expect(card.querySelector('div.line-clamp-2')?.textContent).toBe('보드 재건축');
    expect(card.querySelector('div.mt-1.min-h-5')).not.toBeNull();
  });
});

describe('4908 카드 — «⋯» 버튼과 메뉴', () => {
  it('⭐«⋯» 버튼 이름에 카드 제목이 든다(반복 행 단추 규칙 «{조작} · {이름}»)', () => {
    const card = render();
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(btn.getAttribute('aria-label')).toBe('보드 재건축 카드 메뉴 열기');
  });

  it('«⋯»를 누르면 우클릭과 같은 메뉴가 열리고, kickoff 항목이 그 안에 있다', () => {
    const card = render();
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toContain(koMessages.board.kickoff);
    expect(items).toContain(koMessages.board.changeStatus);
  });

  it('«⋯» 클릭이 카드 열기(onClick)로 새지 않는다', () => {
    const onClick = vi.fn();
    const card = render({ onClick });
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClick).not.toHaveBeenCalled();
  });
});
