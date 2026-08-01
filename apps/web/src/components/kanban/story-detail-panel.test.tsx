// @vitest-environment jsdom
//
// story #2354 회귀 가드 — StoryDetailPanel의 새 `overlayPosition` prop이 (a) 기존 칸반
// 전체화면 드로어를 무변화로 유지하고(회귀 0, AC9) (b) 값을 주면 지도 위에 겹치는 소형
// 팝오버로 바뀌는지(배경 딤 없음·top/height 인라인 스타일 적용) 왕복 검증한다. 내부
// 콘텐츠(작업목록·댓글 등)의 정확성은 kanban-board.test.tsx가 이미 통합 경로로 커버하므로,
// 여기서는 이 PR이 건드린 «바깥 래퍼»만 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { StoryDetailPanel } from './story-detail-panel';
import type { KanbanStory } from './types';
import koMessages from '../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeStory(overrides: Partial<KanbanStory> = {}): KanbanStory {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog', priority: 'medium',
    story_points: null, assignee_id: null, epic_id: null, sprint_id: null,
    description: null, acceptance_criteria: null, attachments: null, position: null,
    success_hypothesis: null, metric_definition: null, measure_after: null,
    outcome_status: 'n_a', outcome_result: null,
    ...overrides,
  };
}

// kanban-board.test.tsx와 같은 관례 — 이 컴포넌트가 내부에서 부르는 나머지 fetch들
// (comments/activities/dependencies/hypotheses/gates 등)는 그레이스풀 폴백 경로만 타면
// 되므로 실패 응답으로 충분하다.
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
}

beforeEach(() => {
  stubFetch();
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'me-1', projectMemberships: [], orgMemberships: [], currentMemberType: 'human' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('StoryDetailPanel — overlayPosition (story #2354, 지도 위에 겹치는 팝오버)', () => {
  it('without overlayPosition: renders the existing full-screen drawer with a dimmed backdrop (칸반 회귀 0, AC9)', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const [backdrop, panel] = Array.from(container.querySelectorAll('[aria-hidden="true"], [role="dialog"]'));
    expect(backdrop?.className).toContain('bg-overlay-backdrop');
    expect(panel?.className).toContain('inset-0');
    expect(panel?.className).toContain('lg:right-0');
    expect((panel as HTMLElement)?.style.top).toBe('');
  });

  it('with overlayPosition: no dimmed backdrop, and the panel uses the given top/height instead of the full drawer classes (지도를 가리지 않는다)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 120, heightPx: 300 }} />,
      ));
    });
    const backdrop = container.querySelector('[aria-hidden="true"]');
    const panel = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(backdrop?.className).not.toContain('bg-overlay-backdrop');
    expect(backdrop?.className).not.toContain('backdrop-blur-sm');
    expect(panel.className).not.toContain('inset-0');
    expect(panel.className).not.toContain('lg:right-0');
    expect(panel.style.top).toBe('120px');
    expect(panel.style.height).toBe('300px');
  });

  it('overlay panel content is the SAME component internals — story title still renders (재사용 확認, AC7)', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory({ title: '겹침 패널 시험용 스토리' })} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    expect(container.textContent).toContain('겹침 패널 시험용 스토리');
  });
});
