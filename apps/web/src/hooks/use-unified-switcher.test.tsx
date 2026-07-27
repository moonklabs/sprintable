// @vitest-environment jsdom
//
// story #2093 후속 — 라이브 재현(계정상태=HITL Dogfood, URL=뭉클랩)에서 스위처 시트가
// "뭉클랩" 헤더 아래 "Dogfood Project"(다른 org 소속)를 그대로 보여주던 결함. 서버 prop
// `projects`(JWT "현재 org" 클레임 스코프)를 그대로 믿지 않고 X-Org-Id로 현재 org를 다시
// 조회해 정본으로 교체하는지 RED→GREEN으로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useUnifiedSwitcher, type OrgSwitcherItem, type ProjectSwitcherItem } from './use-unified-switcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// story #2212 — routerPushMock/searchParamsValue를 테스트별로 갈아끼워 next-복귀·open-redirect
// 가드를 검증한다(기존 테스트는 빈 URLSearchParams로 그대로 동작 — 회귀 없음).
const { routerPushMock, searchParamsValueRef } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  searchParamsValueRef: { current: '' as string },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock, refresh: vi.fn() }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(searchParamsValueRef.current),
}));

let container: HTMLDivElement;
let root: Root;

const ORGS: OrgSwitcherItem[] = [
  { orgId: 'org-moonklabs', orgName: '뭉클랩', orgSlug: 'moonklabs' },
  { orgId: 'org-dogfood', orgName: 'HITL Dogfood Test', orgSlug: 'hitl-dogfood-test' },
];
// 서버 /me/memberships — 계정 상태(JWT "현재 org"=Dogfood)로 스코프된 값. currentOrgId(URL,
// 뭉클랩)와 갈린다 — 이게 바로 그 stale-scope 결함 재현.
const STALE_PROJECTS: ProjectSwitcherItem[] = [{ projectId: 'proj-dogfood', projectName: 'Dogfood Project' }];
const MOONKLABS_PROJECTS = [{ id: 'proj-sprintable', name: 'sprintable' }];

let result: ReturnType<typeof useUnifiedSwitcher> | null = null;

function TestComp() {
  const hook = useUnifiedSwitcher({ orgs: ORGS, currentOrgId: 'org-moonklabs', projects: STALE_PROJECTS, currentProjectId: undefined });
  useEffect(() => { result = hook; });
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  result = null;
  routerPushMock.mockClear();
  searchParamsValueRef.current = '';
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('useUnifiedSwitcher — currentOrgProjects (story #2093 후속)', () => {
  it('시트가 안 열려 있으면 서버 prop을 그대로 낙관적으로 노출한다(불필요한 fetch 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await act(async () => { root.render(<TestComp />); });
    expect(result?.currentOrgProjects).toEqual(STALE_PROJECTS);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('시트를 열면 X-Org-Id로 현재 org를 재조회해 stale한 서버 prop을 정본으로 교체한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const orgId = (init?.headers as Record<string, string>)?.['X-Org-Id'];
      if (orgId === 'org-moonklabs') {
        return { ok: true, json: async () => ({ data: MOONKLABS_PROJECTS }) };
      }
      throw new Error('unexpected org: ' + orgId);
    }));

    await act(async () => { root.render(<TestComp />); });
    // stale 값이 즉시 보이는(깜빡임 없음) 것부터 확認.
    expect(result?.currentOrgProjects).toEqual(STALE_PROJECTS);

    await act(async () => { result?.setOpen(true); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(result?.currentOrgProjects).toEqual([{ projectId: 'proj-sprintable', projectName: 'sprintable' }]);
    // Dogfood Project(다른 org 소속)가 더 이상 뭉클랩 목록에 안 남아있어야 한다.
    expect(result?.currentOrgProjects.some((p) => p.projectId === 'proj-dogfood')).toBe(false);
  });

  it('재조회가 실패하면(네트워크 등) 빈 목록으로 떨어진다 — stale한 다른 org 데이터로 남지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setOpen(true); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(result?.currentOrgProjects).toEqual([]);
  });
});

describe('useUnifiedSwitcher — switchProject의 ?next= 복귀 (story #2212)', () => {
  it('?next=이 안전한 내부경로면 프로젝트 선택 직후 그리로 router.push한다(원 목적지로 복귀)', async () => {
    searchParamsValueRef.current = 'next=%2Fboard';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result?.switchProject('proj-sprintable'); });
    expect(routerPushMock).toHaveBeenCalledWith('/board');
    expect(routerPushMock).toHaveBeenCalledTimes(1); // switchedPath 계산 등 다른 push 없이 next로 한 번만
  });

  it.each([
    ['//evil.com', 'protocol-relative'],
    ['https://evil.com', '절대 URL'],
    ['/\\evil.com', '백슬래시 트릭'],
  ])('?next=%s(%s)는 신뢰하지 않고 무시한다(open-redirect 방지, story #2212)', async (malicious) => {
    searchParamsValueRef.current = `next=${encodeURIComponent(malicious)}`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result?.switchProject('proj-sprintable'); });
    // next를 안 믿으면 기존 경로(pathname 유지 + ?p= 갱신)로 떨어진다 — 외부 도메인으로 직접
    // 이동(router.push의 목적지 자체가 malicious)하는 일은 절대 없어야 한다. malicious 값이
    // 그 fallback URL의 ?next= 쿼리 "값"으로 그대로 남는 것 자체는 안전(어디로도 이동 안 시킴).
    expect(routerPushMock).not.toHaveBeenCalledWith(malicious);
    for (const call of routerPushMock.mock.calls) {
      const dest = String(call[0]);
      expect(dest.startsWith('/moonklabs/sprintable/board')).toBe(true); // 목적지 자체는 항상 내부 경로
    }
  });
});
