// @vitest-environment jsdom
//
// story #2933 H4(P0-H, PO 리뷰 질문 2026-08-22) — 드래그 중 파생 컬럼(needs_input/verified/
// merge_ready)이 "닫히는" 동적 시각(흐림+강조된 힌트 문구)이 실제로 뜨는지. resolveTrustColumnId
// 의 조용한 드롭 무효화만으론 "왜 안 되는지"를 안 보여줘 v4의 "조용히 실패하지 않는다" 원칙에
// 반쪽이라는 지적 — isDragging prop이 실제로 opacity-45+굵은 힌트를 트리거하는지 직접 잰다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import { KanbanTrustColumn } from './kanban-trust-column';
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
    id: 's1', title: '테스트 스토리', status: 'in-progress', priority: 'medium',
    story_points: null, epic_id: null, assignee_id: null, assignee_ids: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
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

function columnDiv(): HTMLElement {
  // 최외곽 컬럼 div — h-full w-[280px] 조합으로 식별(다른 wrapper와 안 겹침).
  return container.querySelector('[class*="w-\\[280px\\]"]') as HTMLElement;
}

describe('KanbanTrustColumn — 파생 컬럼 드래그 중 "닫힘" 시각(story #2933 H4)', () => {
  it('locked=true·isDragging=false(정적 상태) — 힌트는 뜨지만 흐림 처리는 없다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="needs_input" label="입력 필요" locked stories={[story({ trust_stage: 'needs_input' })]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} isDragging={false}
        />,
      ));
    });
    expect(container.textContent).toContain('드롭 불가');
    expect(columnDiv().className).not.toContain('opacity-45');
  });

  it('locked=true·isDragging=true(드래그 中) — 컬럼이 흐려지고 힌트가 강조된다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="needs_input" label="입력 필요" locked stories={[story({ trust_stage: 'needs_input' })]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} isDragging={true}
        />,
      ));
    });
    expect(columnDiv().className).toContain('opacity-45');
    const hint = [...container.querySelectorAll('p')].find((p) => p.textContent?.includes('드롭 불가'));
    expect(hint?.className).toContain('font-semibold');
  });

  it('locked=false(settable 컬럼)는 드래그 中이어도 흐려지지 않는다(닫히는 건 파생 컬럼뿐)', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="running" label="실행 중" locked={false} stories={[story({ trust_stage: 'running' })]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} isDragging={true}
        />,
      ));
    });
    expect(columnDiv().className).not.toContain('opacity-45');
    expect(container.textContent).not.toContain('드롭 불가');
  });
});

// story #2949 — settable 컬럼(locked=false)에 이식된 인라인 컴포저. KanbanColumn과 동형 계약
// (autoComposeSignal로 open·onCreateStory(id, title)로 제출) — 이 컴포넌트는 TrustColumnId→
// 실 status 매핑을 모른다(호출자 몫), 그래서 onCreateStory에 그대로 id를 넘기는지만 잰다.
describe('KanbanTrustColumn — 인라인 컴포저(story #2949)', () => {
  it('locked=false + onCreateStory 있으면 "+" 버튼이 뜨고, 클릭하면 컴포저가 열린다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} onCreateStory={() => {}}
        />,
      ));
    });
    const addButton = container.querySelector('button[aria-label="스토리 추가"]');
    expect(addButton).not.toBeNull();
    expect(container.querySelector('input')).toBeNull(); // 클릭 전엔 닫혀있음.
    await act(async () => { addButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('locked=true(파생 컬럼)는 onCreateStory가 있어도 "+" 버튼을 안 그린다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="needs_input" label="입력 필요" locked stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} onCreateStory={() => {}}
        />,
      ));
    });
    expect(container.querySelector('button[aria-label="스토리 추가"]')).toBeNull();
  });

  it('autoComposeSignal이 0보다 커지면(부모의 CTA 트리거) "+" 클릭 없이도 컴포저가 열린다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} onCreateStory={() => {}}
          autoComposeSignal={0}
        />,
      ));
    });
    expect(container.querySelector('input')).toBeNull();
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} onCreateStory={() => {}}
          autoComposeSignal={1}
        />,
      ));
    });
    expect(container.querySelector('input')).not.toBeNull();
  });

  it('제출하면 onCreateStory(id, title)가 TrustColumnId 그대로(매핑 안 함) 호출된다', async () => {
    const created: Array<[string, string]> = [];
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}}
          onCreateStory={(colId, title) => { created.push([colId, title]); }}
        />,
      ));
    });
    const addButton = container.querySelector('button[aria-label="스토리 추가"]')!;
    await act(async () => { addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '새 스토리');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(created).toEqual([['queued', '새 스토리']]); // ⭐매핑은 호출자 몫 — 여기선 id 그대로.
  });

  it('Escape를 누르면 컴포저가 닫힌다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} onCreateStory={() => {}}
        />,
      ));
    });
    const addButton = container.querySelector('button[aria-label="스토리 추가"]')!;
    await act(async () => { addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('input')).not.toBeNull();
    const input = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('input')).toBeNull();
  });

  it('onCreateStory가 없으면(호출자가 이 컬럼에서 생성을 안 허용) "+" 버튼 자체가 없다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}}
        />,
      ));
    });
    expect(container.querySelector('button[aria-label="스토리 추가"]')).toBeNull();
  });
});
