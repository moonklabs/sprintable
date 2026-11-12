// @vitest-environment jsdom
//
// 4908 — 보드 열 구조 가드. 열 = 내용 칸 층(LAYER.panel)이라 바탕(투명이던 예전)과 카드 사이가 면으로 갈린다 · 잠긴 빈 열의 띠도 같은 면 · 열린 카드(selectedStoryId)가 카드까지 내려간다 ·
// 상태 글은 한 열에 상태가 둘 섞이는 «대기» 열(백로그 / 개발 대기)에서만 카드에 켜진다(담롱군 확인: queued = backlog + ready-for-dev 묶음).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { DndContext } from '@dnd-kit/core';
import { LAYER } from '@/components/ds/layers';
import { KanbanColumn } from './kanban-column';
import { KanbanTrustColumn } from './kanban-trust-column';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
    <DndContext>{node}</DndContext>
  </NextIntlClientProvider>
);

const story = (overrides: Partial<KanbanStory>): KanbanStory => ({
  id: 's1', title: '테스트 스토리', status: 'ready-for-dev', priority: 'medium',
  story_points: null, epic_id: null, assignee_id: null, assignee_ids: [],
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  ...overrides,
}) as KanbanStory;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const columnDiv = () => container.querySelector('[class*="w-\\[280px\\]"]') as HTMLElement;

describe('4908 열 — 면(층)', () => {
  it('⭐신뢰축 열은 내용 칸 층(LAYER.panel)이다 — 투명 바탕이 아니다', async () => {
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="running" label="실행 중" locked={false} stories={[story({ status: 'in-progress' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    expect(columnDiv().className).toContain(LAYER.panel);
    expect(columnDiv().className).not.toContain('bg-transparent');
  });

  it('⭐잠긴 열도 같은 면(안내 글만 다르다) · 비어 있으면 띠도 같은 면', async () => {
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="needs_input" label="입력 필요" locked stories={[story({ trust_stage: 'needs_input' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    expect(columnDiv().className).toContain(LAYER.panel);
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="verified" label="검증·잔존" locked stories={[]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    const strip = container.querySelector('[data-testid="trust-column-strip-verified"]') as HTMLElement;
    expect(strip.className).toContain(LAYER.panel);
  });

  it('클래식 열도 내용 칸 층', async () => {
    await act(async () => {
      root.render(wrap(<KanbanColumn id="in-progress" label="진행 중" stories={[story({ status: 'in-progress' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    expect(columnDiv().className).toContain(LAYER.panel);
  });
});

describe('4908 열 → 카드 전달', () => {
  const cards = () => [...container.querySelectorAll<HTMLElement>('[data-selected]')];

  it('⭐selectedStoryId와 같은 카드만 열린 카드가 된다(신뢰축 · 클래식)', async () => {
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="queued" label="대기" locked={false} stories={[story({ id: 'a' }), story({ id: 'b' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} selectedStoryId="b" />));
    });
    expect(cards()).toHaveLength(1);
    await act(async () => {
      root.render(wrap(<KanbanColumn id="backlog" label="백로그" stories={[story({ id: 'a' }), story({ id: 'b' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} selectedStoryId="a" />));
    });
    expect(cards()).toHaveLength(1);
  });

  it('⭐«대기» 열 카드만 상태 글을 켠다 — 다른 열은 열이 곧 상태', async () => {
    const label = koMessages.board.readyForDev;
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="queued" label="대기" locked={false} stories={[story({ id: 'a' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    expect(container.textContent).toContain(label);
    await act(async () => {
      root.render(wrap(<KanbanTrustColumn id="running" label="실행 중" locked={false} stories={[story({ id: 'a', status: 'ready-for-dev' })]} epicMap={{}} memberMap={{}} onStoryClick={() => {}} />));
    });
    expect(container.textContent).not.toContain(label);
  });
});
