// @vitest-environment jsdom
//
// story 5e229540(doc resource-view-firsttouch-identity-pattern §4 "스프린트" 행): 빈 목록
// first-touch가 밋밋한 "스프린트가 없습니다." 대신 5요소(아이콘+headline+explainer+기간bar+
// CTA+hint) 정체성 explainer로 렌더되는지, CTA가 기존 생성 폼(setShowCreate)을 재사용하는지,
// 데이터 있으면 완전 무변화인지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

// story #2104 — HumanOnlyAction(스프린트 삭제 트리거를 감싼다)이 useDashboardContext를 읽는다.
// 기본은 human(기존 first-touch 스위트는 게이팅과 무관). agent 케이스만 개별 override.
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

function stubFetch(sprints: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: sprints }) };
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
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => { root.render(wrap(<SprintsClient projectId="proj-1" orgId="org-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('SprintsClient — 스프린트 first-touch 정체성', () => {
  it('빈 목록이 5요소 explainer(headline+설명+기간bar+CTA+hint)로 렌더된다 — 구 "스프린트가 없습니다." 소거', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 시작한 스프린트가 없어요');
    expect(html).toContain('스프린트는 한 번의 집중 사이클이에요');
    expect(html).toContain('첫 스프린트 시작하기');
    expect(html).toContain('시작할 때 가설 하나만 선언하면 돼요');
    expect(html).not.toContain('스프린트가 없습니다.'); // 구 카피 소거
  });

  it('빈 상태 CTA 클릭 시 기존 생성 폼이 열린다(신규 다이얼로그 없음)', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스프린트 시작하기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 생성 폼 오픈 시 노출되는 필드 라벨로 폼이 실제 열렸는지 확인. story #2061: CreateDialog가
    // 공용 Dialog(base-ui)로 교체되며 document.body로 포탈 렌더되므로 container가 아닌
    // document.body를 본다(내용/동작은 동일 — DOM 위치만 바뀜).
    expect(document.body.textContent).toContain('스프린트 이름');
  });

  it('스프린트 데이터가 있으면 기존 리스트가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    stubFetch([{ id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' }]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('Sprint 1');
    expect(html).not.toContain('아직 시작한 스프린트가 없어요');
    expect(html).not.toContain('첫 스프린트 시작하기');
  });

  // story #2104 — BE sprints.py:351(human-only 삭제 403)를 FE가 미리 안 보고 에이전트 계정에도
  // 삭제 트리거를 무조건 열었다(#2091/#2103과 같은 결함). 양방향 고정 — human까지 잠그면
  // 정당한 삭제가 봉쇄되는 더 큰 사고다(승격 위험목록의 잔여 미검증 칸 해소).
  it('human이면 스프린트 삭제 트리거가 렌더된다(정당한 사용자는 막히면 안 됨)', async () => {
    stubFetch([{ id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' }]);
    await mount();
    const row = [...container.querySelectorAll('li')].find((li) => li.textContent?.includes('Sprint 1'));
    expect(row).not.toBeUndefined();
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).not.toBeNull();
  });

  it('agent면 스프린트 삭제 트리거가 안 뜬다', async () => {
    useDashboardContextMock.mockReturnValue({ currentMemberType: 'agent' });
    stubFetch([{ id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' }]);
    await mount();
    const row = [...container.querySelectorAll('li')].find((li) => li.textContent?.includes('Sprint 1'));
    expect(row).not.toBeUndefined();
    await act(async () => { row!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.querySelector('button[aria-label="스프린트 삭제"]')).toBeNull();
  });
});
