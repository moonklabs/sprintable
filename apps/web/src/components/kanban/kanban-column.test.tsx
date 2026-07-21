// @vitest-environment jsdom
//
// story #2062 — kanban-column.tsx의 스크롤 컨테이너(overflow-y-auto)가 패딩 0이라 카드
// 포커스 링(#2057, outline-offset 2px+width 2px=4px 돌출)이 스크롤 클리핑 박스에 위·좌·우
// 3면이 잘리던 회귀. 스크롤 컨테이너 자신에게 여백(p-1.5=6px, 4px 돌출분보다 넉넉)이 있는지를
// 실제 DOM(createRoot)으로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import { KanbanColumn } from './kanban-column';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <DndContext>{node}</DndContext>
    </NextIntlClientProvider>
  );
}

function story(overrides: Partial<KanbanStory>): KanbanStory {
  return {
    id: 's1',
    title: '테스트 스토리',
    status: 'backlog',
    priority: 'medium',
    story_points: null,
    epic_id: null,
    assignee_id: null,
    assignee_ids: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as KanbanStory;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('KanbanColumn — story #2062 포커스 링 클리핑', () => {
  it('카드 스크롤 컨테이너(overflow-y-auto)에 여백(p-1.5)이 있다 — 링 4면 보임 자리 확보', async () => {
    await act(async () => {
      root.render(
        wrap(
          <KanbanColumn
            id="backlog"
            label="백로그"
            stories={[story({ id: 's1' })]}
            epicMap={{}}
            memberMap={{}}
            onStoryClick={vi.fn()}
          />,
        ),
      );
    });

    const scrollContainer = container.querySelector('.overflow-y-auto');
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.className).toContain('p-1.5');
  });
});
