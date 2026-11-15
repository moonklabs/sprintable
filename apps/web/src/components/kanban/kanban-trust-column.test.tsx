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

// story #2969 §1.3-b(doc proofline-system-layer-2969, PR-6) — 유나 실픽셀 갭 fix:
// kanban-column.tsx(클래식 축)만 하고 이 컴포넌트(6단계 신뢰축=기본 보드 화면)를
// 놓쳤던 것. 컬럼헤더=소헤딩(Heading 무게), 크기/sans 불변.
describe('KanbanTrustColumn — 컬럼헤더 소헤딩(story #2969 PR-6)', () => {
  it('컬럼헤더가 font-extrabold(Heading 무게)를 갖고 크기(text-xs)는 그대로다', async () => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="queued" label="대기" locked={false} stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}}
        />,
      ));
    });
    const header = container.querySelector('h3');
    expect(header).not.toBeNull();
    expect(header?.className).toContain('font-extrabold');
    expect(header?.className).toContain('text-xs');
    expect(header?.className).not.toContain('font-semibold');
    expect(header?.className).not.toContain('font-mono');
    expect(header?.className).not.toContain('uppercase');
  });
});

// story #4888(UI-5 보드 머리 첫 조각, AC3 §4-3) — 비어 있는 잠긴(파생) 열은 280px 칸 대신 좁은 띠(40px)로 접힌다.
// 좁히는 것이지 지우는 게 아니다: 이름 · 0건 · 드롭 불가 안내(title · 스크린리더)는 띠에 남는다. 카드가 생기거나 더 불러올 쪽이 있으면 다시 선다.
describe('KanbanTrustColumn — 빈 잠긴 열은 좁은 띠(story #4888)', () => {
  const render = async (props: Partial<React.ComponentProps<typeof KanbanTrustColumn>>) => {
    await act(async () => {
      root.render(wrap(
        <KanbanTrustColumn
          id="needs_input" label="입력 필요" locked stories={[]}
          epicMap={{}} memberMap={{}} onStoryClick={() => {}} {...props}
        />,
      ));
    });
  };
  const strip = () => container.querySelector<HTMLElement>('[data-testid="trust-column-strip-needs_input"]');

  it('잠김 + 0건 → 띠(w-10)이고 280px 칸 · 제목 h3 · 빈 문구는 없다', async () => {
    await render({});
    expect(strip()).not.toBeNull();
    expect(strip()!.className.split(/\s+/)).toContain('w-10');
    expect(columnDiv()).toBeNull();
    expect(container.querySelector('h3')).toBeNull();
    expect(container.textContent).not.toContain(koMessages.board.noStories);
  });

  it('띠에도 열 이름 · 0건 · 드롭 불가 안내가 남는다(잃은 정보 0)', async () => {
    await render({});
    expect(strip()!.textContent).toContain('입력 필요');
    expect(strip()!.textContent).toContain('0');
    expect(strip()!.textContent).toContain(koMessages.board.trustLockedDropHint);
    expect(strip()!.getAttribute('title')).toContain(koMessages.board.trustLockedDropHint);
    expect(strip()!.getAttribute('title')).toContain('입력 필요');
  });

  it('[4923 재오픈] 띠 세로 글은 줄을 바꾸지 않고(whitespace-nowrap), 낮은 데스크톱 창(높이 ≤ 520)에선 장식 자물쇠만 뺀다 — 낮은 창서 «입력필 / 요»로 갈라지던 것', async () => {
    await render({});
    const label = Array.from(strip()!.querySelectorAll('span')).find((s) => s.textContent === '입력 필요')!;
    expect(label.className.split(/\s+/)).toContain('whitespace-nowrap');
    // 자리가 모자라면 줄바꿈 · 겹침 대신 «…»로 잘린다(전체 이름은 띠 title이 말한다)
    for (const c of ['min-h-0', 'overflow-hidden', 'text-ellipsis']) expect(label.className.split(/\s+/)).toContain(c);
    expect(label.className).toContain('[writing-mode:vertical-rl]');
    // 낮은 창에선 띠 위아래 여백도 12 → 8(글자 폭이 더 넓은 실제 글꼴 — Pretendard — 에서도 영문 «Needs Input»이 한 줄로 들도록 8px 더 — 시험 브라우저엔 그 글꼴이 없어 e2e는 이 한 줄을 가르지 못한다)
    expect(strip()!.className).toContain('lg:[@media(max-height:520px)]:py-2');
    const lock = strip()!.querySelector('svg')!;
    expect(lock.getAttribute('class')).toContain('lg:[@media(max-height:520px)]:hidden');
    // 잠금 안내는 자물쇠 그림이 아니라 글이 말한다(title · 스크린리더 글) — 그림을 빼도 정보 0 손실
    expect(strip()!.textContent).toContain(koMessages.board.trustLockedDropHint);
    expect(strip()!.getAttribute('title')).toContain(koMessages.board.trustLockedDropHint);
  });

  it('카드가 1장이라도 있으면 원래 칸이다(띠 아님)', async () => {
    await render({ stories: [story({ trust_stage: 'needs_input' })] });
    expect(strip()).toBeNull();
    expect(columnDiv()).not.toBeNull();
    expect(container.querySelector('h3')?.textContent).toContain('입력 필요');
  });

  it('0건이어도 더 불러올 쪽이 있으면(hasMore · N+) 원래 칸이다 — 0으로 단정하는 띠 금지', async () => {
    await render({ hasMore: true, moreViaFeeder: true });
    expect(strip()).toBeNull();
    expect(container.textContent).toContain('0+');
  });

  it('잠기지 않은(settable) 빈 열은 띠가 되지 않는다 — 여기서 일감을 만든다', async () => {
    await render({ id: 'queued', label: '대기', locked: false, onCreateStory: () => {} });
    expect(container.querySelector('[data-testid^="trust-column-strip-"]')).toBeNull();
    expect(columnDiv()).not.toBeNull();
    expect(container.querySelector('button[aria-label]')).not.toBeNull();
  });

  it('끌기 중에도 띠는 폭이 그대로(w-10)이고 흐려질 뿐이다 — 도중에 칸 폭이 바뀌면 놓을 자리 판정이 흔들린다', async () => {
    await render({ isDragging: true });
    expect(strip()!.className.split(/\s+/)).toContain('w-10');
    expect(strip()!.className).toContain('opacity-45');
  });
});
