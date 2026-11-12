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

describe('4908 카드 — codex 검수 반영', () => {
  it('⭐«⋯» 버튼은 누름 · 키를 카드(끌기 · 집기를 소유)로 흘리지 않는다 — 누르다 8px 움직여 끌기가 시작되거나 Enter/Space가 집기로 읽히지 않게', () => {
    const outerPointer = vi.fn();
    const outerKey = vi.fn();
    act(() => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <DndContext>
            <div onPointerDown={outerPointer} onKeyDown={outerKey}>
              <StoryCard story={makeStory()} onClick={() => {}} projectId="p1" />
            </div>
          </DndContext>
        </NextIntlClientProvider>,
      );
    });
    const btn = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => {
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(outerPointer).not.toHaveBeenCalled();
    expect(outerKey).not.toHaveBeenCalled();
    // Esc · Tab 같은 그 밖의 키는 막지 않는다(메뉴 닫기 · 초점 이동이 문서까지 닿아야 한다).
    act(() => { btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(outerKey).toHaveBeenCalledTimes(1);
  });

  it('⭐메뉴 항목이 하나도 없는 카드(에픽 스윔레인 — 조작 콜백이 없다)에는 «⋯» 버튼이 없다 — 빈 메뉴가 열리지 않는다', () => {
    const card = render({ projectId: undefined, onChangeStatus: undefined });
    expect(card.querySelector('button[aria-haspopup="menu"]')).toBeNull();
  });

  it('⭐«⋯»로 연 메뉴는 화면 아래쪽에서도 뷰포트 안에 선다(세로 clamp)', () => {
    vi.stubGlobal('innerHeight', 600);
    const card = render();
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    btn.getBoundingClientRect = () => ({ top: 570, bottom: 590, left: 10, right: 34, width: 24, height: 20, x: 10, y: 570, toJSON: () => ({}) });
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    const items = menu.querySelectorAll('[role="menuitem"]').length;
    expect(parseFloat(menu.style.top)).toBeLessThanOrEqual(600 - (items * 36 + 8) - 8);
    vi.unstubAllGlobals();
  });

  it('«⋯» 버튼이 메뉴가 열렸는지(aria-expanded)를 말한다', () => {
    const card = render();
    const btn = card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('⭐에이전트가 담당 넷째 이후에 있어도 스크린리더 글(«에이전트»)이 남는다(예전 hasAgent는 전원을 봤다)', () => {
    const members = [
      { id: 'h1', name: '가', type: 'human' }, { id: 'h2', name: '나', type: 'human' }, { id: 'h3', name: '다', type: 'human' },
      { id: 'a4', name: '에이전트넷', type: 'agent' },
    ];
    const card = render({ assignees: members as never });
    expect(card.textContent).toContain(koMessages.board.filterAgents);
    const noAgent = render({ assignees: members.slice(0, 3) as never });
    expect(noAgent.textContent).not.toContain(koMessages.board.filterAgents);
  });

  it('열린 카드의 글자는 한 단계 진한 ink-2(흐린 ink-3 아님)', () => {
    expect(render({ selected: true }).querySelector('div.min-h-5')?.className).toContain('text-ds-ink-2');
    expect(render({ selected: false }).querySelector('div.min-h-5')?.className).toContain('text-ds-ink-3');
  });
});
