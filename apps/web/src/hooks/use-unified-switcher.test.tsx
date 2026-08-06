// @vitest-environment jsdom
//
// story #2093 후속 — 라이브 재현(계정상태=HITL Dogfood, URL=뭉클랩)에서 스위처 시트가
// "뭉클랩" 헤더 아래 "Dogfood Project"(다른 org 소속)를 그대로 보여주던 결함. 서버 prop
// `projects`(JWT "현재 org" 클레임 스코프)를 그대로 믿지 않고 X-Org-Id로 현재 org를 다시
// 조회해 정본으로 교체하는지 RED→GREEN으로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { useUnifiedSwitcher, type OrgSwitcherItem, type ProjectSwitcherItem } from './use-unified-switcher';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';
import koMessages from '../../messages/ko.json';

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

function InnerTestComp() {
  const hook = useUnifiedSwitcher({ orgs: ORGS, currentOrgId: 'org-moonklabs', projects: STALE_PROJECTS, currentProjectId: undefined });
  useEffect(() => { result = hook; });
  return null;
}

// story #2468 — useUnifiedSwitcher가 이제 useTranslations('nav')를 쓴다(에러 문구).
// NextIntlClientProvider 없이 렌더하면 "context ... was not found"로 즉시 죽는다.
function TestComp() {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <InnerTestComp />
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  result = null;
  routerPushMock.mockClear();
  searchParamsValueRef.current = '';
  window.sessionStorage.clear(); // story #2468 — 테스트 간 stale project_id 오염 방지
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

// story #2468(a)(2026-08-06 미르코 라이브 재현) — "새 프로젝트" 버튼 무반응의 정체는 조용한
// 403이었다: org 전환 後에도 sessionStorage(TAB_PROJECT_STORAGE_KEY)가 전환 前 org의
// project_id를 그대로 들고 있어, 전역 fetch 인터셉터(project-context-client.ts)가 그 stale
// id를 X-Project-Id로 계속 실어 보내고 — 새 org엔 그 프로젝트가 없어 BE가 403을 낸다.
describe('useUnifiedSwitcher — switchOrg의 stale sessionStorage 클리어 (story #2468 a)', () => {
  it('org 전환 성공 시 TAB_PROJECT_STORAGE_KEY sessionStorage를 지운다(다음 org에 없는 project_id를 안 실어 보내게)', async () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'proj-from-previous-org');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchOrg('org-dogfood'); });

    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('org 전환 실패(응답 실패) 時엔 sessionStorage를 안 건드린다 — 롤백된 org 그대로면 그 project_id는 여전히 유효하다', async () => {
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, 'proj-still-valid');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: { code: 'SWITCH_FAILED' } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchOrg('org-dogfood'); });

    expect(window.sessionStorage.getItem(TAB_PROJECT_STORAGE_KEY)).toBe('proj-still-valid');
  });
});

// story #2468(b, 근본) — 실패를 침묵하지 않는다. 예전엔 createProject가 !res.ok에 그냥 false만
// 반환했고, 호출부(unified-switcher.tsx·context-switcher-chip.tsx)가 그 값을 void로 버려
// "버튼 무반응"으로 보였다. 원인이 뭐든(403/기타) 화면에 명시 에러가 뜨는지를 고정한다.
describe('useUnifiedSwitcher — createProject 실패 표시 (story #2468 b)', () => {
  it('생성 실패(403 등) 時 createProjectError가 채워지고, 다이얼로그는 안 닫히고, false를 반환한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: { code: 'FORBIDDEN', message: 'No access to the specified project' } }),
    })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setCreateProjectOpen(true); });

    let returned: boolean | undefined;
    await act(async () => { returned = await result?.createProject('새 프로젝트', ''); });

    expect(returned).toBe(false);
    expect(result?.createProjectError).toBeTruthy();
    expect(result?.createProjectOpen).toBe(true); // 조용히 닫히지 않는다 — 사용자가 에러를 본다
  });

  it('생성 성공 時엔 createProjectError가 null이고 다이얼로그가 닫힌다(회귀가드)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: { id: 'proj-new' } }) };
      return { ok: true, json: async () => ({ data: { ok: true } }) }; // switch-project 등
    }));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setCreateProjectOpen(true); });

    await act(async () => { await result?.createProject('새 프로젝트', ''); });

    expect(result?.createProjectError).toBeNull();
    expect(result?.createProjectOpen).toBe(false);
  });

  it('다이얼로그를 다시 열면(setCreateProjectOpen) 이전 실패 문구가 지워진다 — 낡은 에러가 새 시도처럼 안 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: { code: 'FORBIDDEN' } }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setCreateProjectOpen(true); });
    await act(async () => { await result?.createProject('새 프로젝트', ''); });
    expect(result?.createProjectError).toBeTruthy();

    await act(async () => { result?.setCreateProjectOpen(false); });
    expect(result?.createProjectError).toBeNull();
  });
});
