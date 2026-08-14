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
import { bumpOrgSyncVersion } from '@/lib/project-context-client';

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

// story #2528 — 전역 스크롤바 숨김(#2165) 하에 상세패널 본문 스크롤 컨테이너가 예외 목록에
// 없어 스크롤바가 안 보이던 결함. globals.css 범용 옵트인 `.scrollbar-visible` 클래스 적용
// 계약을 고정한다. jsdom은 실 스크롤바 렌더를 계산하지 않으므로 실제 가시성은 라이브 QA 몫
// (스토리 AC의 "라이브 픽셀 양성대조"가 결정적 게이트).
describe('StoryDetailPanel — #2528 본문 스크롤바 가시성', () => {
  it('본문 overflow-y-auto 컨테이너에 scrollbar-visible 클래스가 적용된다', async () => {
    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body).toBeTruthy();
    expect(body?.className).toContain('scrollbar-visible');
  });

  it('겹침 팝오버 모드에서도 본문 스크롤 컨테이너의 클래스는 회귀 없이 유지된다', async () => {
    await act(async () => {
      root.render(wrap(
        <StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} overlayPosition={{ top: 0, heightPx: 300 }} />,
      ));
    });
    const body = Array.from(container.querySelectorAll('div')).find((d) => d.className.includes('overflow-y-auto'));
    expect(body?.className).toContain('scrollbar-visible');
  });
});

// story #2593(#2545 후속) — kanban `?story=` 딥링크로 이 패널이 콜드 하드네비 직후 열리면
// comments/activities/labels/references/dependencies/gates 6개 auto-mount fetch effect가
// switch-org 완료 前에 구 org_id로 먼저 발사될 수 있다. #2946과 동형 stale-guard(orgSyncVersion
// deps + cancelled 플래그)를 얹었는지를, "org-switch 신호 → 재요청 → 늦게 도착한 구 응답이
// 새 응답을 덮지 않는다"는 실제 레이스로 검증한다(대표로 comments effect 사용).
describe('StoryDetailPanel — org-switch 잔여 레이스 stale-guard (story #2593, #2545 후속)', () => {
  it('org-switch 재요청 이후 늦게 도착한 구 org 응답이 새 org 응답을 덮지 않는다', async () => {
    let resolveFirst: ((v: unknown) => void) | undefined;
    let resolveSecond: ((v: unknown) => void) | undefined;
    let commentsCallCount = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/comments?limit=20')) {
        commentsCallCount += 1;
        if (commentsCallCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
        return new Promise((resolve) => { resolveSecond = resolve; });
      }
      return Promise.resolve({ ok: false, json: async () => null });
    }));

    await act(async () => {
      root.render(wrap(<StoryDetailPanel story={makeStory()} tasks={[]} onClose={() => {}} />));
    });
    expect(commentsCallCount).toBe(1); // 최초 마운트 — 구 org 요청(1st) 발사

    // DashboardShell의 switch-org 성공 신호 — orgSyncVersion 구독 effect가 재요청되어야 한다.
    await act(async () => { bumpOrgSyncVersion(); });
    expect(commentsCallCount).toBe(2); // 신 org 요청(2nd) 발사 확인 — 재요청 자체가 안 되면 여기서 실패(구코드 회귀)

    // 신 org 응답(2nd)이 먼저 도착
    await act(async () => {
      resolveSecond?.({ ok: true, json: async () => ({ data: [{ id: 'fresh', content: 'FRESH_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    const trigger = () => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Comments'));
    expect(trigger()?.textContent).toBe('Comments (1)');

    // 구 org 응답(1st)이 뒤늦게 도착 — cancelled라 무시돼야 fresh 상태가 안 덮인다.
    await act(async () => {
      resolveFirst?.({ ok: true, json: async () => ({ data: [{ id: 'stale', content: 'STALE_ORG_COMMENT', created_by: 'u', created_at: '2026-01-01' }] }) });
    });
    expect(trigger()?.textContent).toBe('Comments (1)'); // 여전히 1 — stale 응답이 2번째로 덮어쓰지 않았다
  });
});
