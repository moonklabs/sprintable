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

// story #2969 §1.3-b(doc proofline-system-layer-2969, PR-5) — 컬럼헤더=소헤딩(Heading
// 무게로 재분류·크기/sans 불변, 한글이라 caps/mono 금지).
describe('KanbanColumn — 컬럼헤더 소헤딩(story #2969 PR-5)', () => {
  it('컬럼헤더가 font-extrabold(Heading 무게)를 갖고 크기(text-xs)는 그대로다', async () => {
    await act(async () => {
      root.render(
        wrap(
          <KanbanColumn
            id="backlog"
            label="백로그"
            stories={[]}
            epicMap={{}}
            memberMap={{}}
            onStoryClick={vi.fn()}
          />,
        ),
      );
    });

    const header = container.querySelector('h3');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('font-extrabold');
    expect(header?.className).toContain('text-xs');
    expect(header?.className).not.toContain('font-semibold');
    // 한글 라벨 — mono/uppercase/caps 금지(2967 교훈, [[feedback_copy_from_korean_convention]]).
    expect(header?.className).not.toContain('font-mono');
    expect(header?.className).not.toContain('uppercase');
  });
});

// 유나 design:changes(PR#3687, story #3287 AC4, 2026-09-01) — org 커스텀 라벨은 길이가
// 자유라 고정폭 컬럼(w-[280px])에서 WIP 카운트·버튼을 밀어낼 수 있었다.
describe('KanbanColumn — 긴 org 라벨이 WIP 카운트를 안 밀어낸다(유나 design:changes, PR#3687)', () => {
  it('헤더 h3가 min-w-0, 라벨 span이 truncate+title(전체 문구)을 갖는다', async () => {
    const longLabel = '아이디어 검토 대기열 — 마케팅팀 승인 전 임시 보관함(매우 긴 org 커스텀 라벨)';
    await act(async () => {
      root.render(
        wrap(
          <KanbanColumn
            id="backlog"
            label={longLabel}
            stories={[]}
            epicMap={{}}
            memberMap={{}}
            onStoryClick={vi.fn()}
          />,
        ),
      );
    });

    const header = container.querySelector('h3');
    expect(header?.className).toContain('min-w-0');
    const labelSpan = header?.querySelector('span[title]');
    expect(labelSpan).not.toBeNull();
    expect(labelSpan?.className).toContain('truncate');
    expect(labelSpan?.getAttribute('title')).toBe(longLabel);
    expect(labelSpan?.textContent).toBe(longLabel);
  });

  it('WIP 배지·카운트를 담은 우측 그룹은 shrink-0 — 라벨이 길어도 이쪽이 안 밀린다', async () => {
    await act(async () => {
      root.render(
        wrap(
          <KanbanColumn
            id="backlog"
            label="백로그"
            stories={[]}
            epicMap={{}}
            memberMap={{}}
            onStoryClick={vi.fn()}
            wipLimit={5}
          />,
        ),
      );
    });

    const header = container.querySelector('h3');
    const rightGroup = header?.nextElementSibling;
    expect(rightGroup?.className).toContain('shrink-0');
  });
});
