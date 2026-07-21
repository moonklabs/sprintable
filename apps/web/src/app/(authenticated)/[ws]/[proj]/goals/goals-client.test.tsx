// @vitest-environment jsdom
//
// story 3995840c(doc resource-view-firsttouch-identity-pattern §4 "에픽"→"목표" 행): 빈 목록
// first-touch가 제네릭 카피 대신 5요소(아이콘+headline+explainer+그룹hint+CTA) 정체성
// explainer로 렌더되는지, 필터 적용 중 결과 0건(진짜 빈 프로젝트 아님)은 별개의 중립 카피를
// 쓰는지(no-fiction), 데이터 있으면 완전 무변화인지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('./goals-context', () => ({
  useGoalsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// story #2104 — HumanOnlyAction(에픽 삭제 트리거를 감싼다)이 useDashboardContext를 읽는다.
// 기본은 human(기존 스위트가 전부 "리스트가 정상 렌더된다"만 확認하므로 무관). agent 게이팅
// 자체를 보는 케이스만 개별 override.
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

function stubFetch(epics: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/goals?')) {
      return { ok: true, json: async () => ({ data: epics }) };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { GoalsClient } = await import('./goals-client');
  await act(async () => { root.render(wrap(<GoalsClient projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('GoalsClient — 목표 first-touch 정체성', () => {
  it('진짜 빈 프로젝트(목표 0건)면 5요소 explainer로 렌더된다 — 구 제네릭 카피 소거', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 목표가 없어요');
    expect(html).toContain('목표는 이루려는 하나의 큰 성과예요');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0); // Flag 아이콘 + 그룹hint
    expect(html).not.toContain('에픽'); // 8fc51517: "에픽" 잔존 소거
  });

  it('필터로 인한 결과 0건(진짜 빈 프로젝트 아님)은 중립 카피를 쓴다 — "아직 시작 안 함" 오해 방지(no-fiction)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    // story #2017: 필터 탭이 raw status 값('draft')을 그대로 렌더하던 버그를 고쳐 KO 로케일에선
    // 번역된 라벨('초안')로 렌더된다 — 이 테스트도 그 정정에 맞춰 갱신.
    const draftFilterButton = [...container.querySelectorAll('button')].find((b) => b.textContent === '초안');
    expect(draftFilterButton).not.toBeUndefined();
    await act(async () => { draftFilterButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const html = container.innerHTML;
    expect(html).toContain('이 상태의 목표가 없습니다.');
    // 정체성 explainer(진짜 빈상태 전용 카피)는 여기 새면 안 됨 — 목표가 실재하는데 "시작 안 함"은 거짓.
    expect(html).not.toContain('아직 목표가 없어요');
  });

  it('데이터 있으면 기존 리스트가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('E-CANVAS');
    expect(html).not.toContain('아직 목표가 없어요');
  });

  // story #2104 — BE goals.py:352(human-only 삭제 403)를 FE가 미리 안 보고 에이전트 계정에도
  // 삭제 트리거를 무조건 열었다(#2091/#2103과 같은 결함). 양방향 고정 — human까지 잠그면
  // 정당한 삭제가 봉쇄되는 더 큰 사고다.
  it('human이면 에픽 삭제 트리거가 렌더된다(정당한 사용자는 막히면 안 됨)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    expect(container.querySelector('button[aria-label="목표 삭제"]')).not.toBeNull();
  });

  it('agent면 에픽 삭제 트리거가 안 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    expect(container.querySelector('button[aria-label="목표 삭제"]')).toBeNull();
  });
});
