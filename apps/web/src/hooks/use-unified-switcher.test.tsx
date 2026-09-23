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

// story f401139e — switchProject/switchOrgAndProject가 예전엔 현재 searchParams를 통째로
// 이월하고 `p`만 갈아끼웠다. 리소스-scoped 쿼리(`story`/`hypothesis`/`id` 등)가 새 프로젝트로
// 그대로 넘어가면 존재하지도 않는(또는 다른 프로젝트 소속) 리소스를 새 URL 아래서 열려고
// 시도하게 되는 결함(그라운딩 확認)이라 화이트리스트로 뒤집었다 — project-agnostic 값(`view`·
// `tab`)만 명시 이월하고 나머지는 기본적으로 버린다.
function destQueryParams(dest: string): URLSearchParams {
  const qIndex = dest.indexOf('?');
  return new URLSearchParams(qIndex === -1 ? '' : dest.slice(qIndex + 1));
}

describe('useUnifiedSwitcher — 전환 시 쿼리파라미터 화이트리스트 (story f401139e)', () => {
  it('switchProject: view/tab(project-agnostic)만 이월하고 story/hypothesis/id(리소스-scoped)는 버린다', async () => {
    searchParamsValueRef.current = 'story=story-1&view=canvas&hypothesis=hyp-1&tab=board&id=sprint-1';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchProject('proj-sprintable'); });

    expect(routerPushMock).toHaveBeenCalledTimes(1);
    const dest = String(routerPushMock.mock.calls[0]![0]);
    const q = destQueryParams(dest);
    expect(q.get('view')).toBe('canvas');
    expect(q.get('tab')).toBe('board');
    expect(q.get('p')).toBe('proj-sprintable');
    expect(q.has('story')).toBe(false);
    expect(q.has('hypothesis')).toBe(false);
    expect(q.has('id')).toBe(false);
  });

  it('switchOrgAndProject: 동일 화이트리스트 정책이 org+project 동시전환에도 적용된다', async () => {
    searchParamsValueRef.current = 'story=story-1&view=list&assignee_id=member-9';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchOrgAndProject('org-dogfood', 'proj-dogfood'); });

    expect(routerPushMock).toHaveBeenCalledTimes(1);
    const dest = String(routerPushMock.mock.calls[0]![0]);
    const q = destQueryParams(dest);
    expect(q.get('view')).toBe('list');
    expect(q.get('p')).toBe('proj-dogfood');
    expect(q.has('story')).toBe(false);
    expect(q.has('assignee_id')).toBe(false);
  });

  it('project-agnostic 파라미터가 아예 없으면 p만 실린다(빈 값 오염 없음)', async () => {
    searchParamsValueRef.current = 'story=story-1&epic_id=epic-1';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchProject('proj-sprintable'); });

    const dest = String(routerPushMock.mock.calls[0]![0]);
    const q = destQueryParams(dest);
    expect([...q.keys()]).toEqual(['p']);
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

// story #2544 — switchOrg/switchOrgAndProject는 localOrgId를 optimistic으로 먼저 찍고(클릭
// 즉시 "전환됨"으로 보임) try에 catch가 없었다: fetch 자체가 던지면(네트워크 실패 등) else의
// revert를 절대 못 타 — 실제 전환은 실패했는데 드롭다운은 "전환됨"으로 영구 고정된다. 카디르
// QA 라이브 재현("선택·체크까지 되고... 실제론 안 됨")과 정확히 같은 모양 — 이 테스트는
// pre-fix에서 RED(localOrgId가 실패 후에도 nextOrgId로 고정), fix 後 GREEN을 고정한다.
describe('useUnifiedSwitcher — switchOrg 네트워크 실패 시 optimistic 상태 복구 (story #2544)', () => {
  it('switchOrg 中 fetch가 던지면(네트워크 실패) localOrgId를 되돌리고 switchOrgError를 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await act(async () => { root.render(<TestComp />); });
    expect(result?.currentOrg?.orgId).toBe('org-moonklabs');

    await act(async () => { await result?.switchOrg('org-dogfood'); });

    // ⛔fix 前엔 여기서 'org-dogfood'로 영구 고정됐다(되돌아오지 않음) — 이게 바로
    // "선택·체크는 되는데 실제 org는 안 바뀐" 카디르 QA 재현의 근본.
    expect(result?.currentOrg?.orgId).toBe('org-moonklabs');
    expect(result?.switchOrgError).toBeTruthy();
    expect(result?.pending).toBe(false); // finally는 원래도 돌아 stuck-pending은 아니었다
  });

  it('switchOrgAndProject 中 switch-org 자체가 던지면 switchOrgError를 채운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchOrgAndProject('org-dogfood', 'proj-dogfood'); });

    expect(result?.switchOrgError).toBeTruthy();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it('정상 전환 성공 時엔 switchOrgError가 null이다(회귀가드)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });

    await act(async () => { await result?.switchOrg('org-dogfood'); });

    expect(result?.switchOrgError).toBeNull();
    expect(result?.currentOrg?.orgId).toBe('org-dogfood');
  });

  it('재시도 시작 時 이전 switchOrgError가 지워진다(낡은 에러가 새 시도처럼 안 보임)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result?.switchOrg('org-dogfood'); });
    expect(result?.switchOrgError).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async () => new Promise(() => {}))); // 두 번째 시도는 아직 안 끝남
    await act(async () => { void result?.switchOrg('org-dogfood'); });
    expect(result?.switchOrgError).toBeNull();
  });
});

// story #3147(doc mobile-switcher-redesign-spec-4758744a §③) — 검색 state 신규. 데스크톱
// UnifiedSwitcher(lg:)는 이 필드를 안 읽으므로 여기 추가가 그쪽에 영향 없다(호출부 무변경).
describe('useUnifiedSwitcher — story #3147 검색 state(신규)', () => {
  it('searchQuery가 비어 있으면 filteredCurrentOrgProjects는 currentOrgProjects와 같다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return { ok: true, json: async () => ({ data: MOONKLABS_PROJECTS }) };
      return { ok: true, json: async () => ({ data: { ok: true } }) };
    }));
    await act(async () => { root.render(<TestComp />); });
    expect(result?.filteredCurrentOrgProjects.length).toBe(result?.currentOrgProjects.length);
  });

  it('searchQuery 설정 시 프로젝트명 부분일치로만 필터한다(대소문자 무시)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ data: [
          { id: 'p1', name: 'Sprintable' }, { id: 'p2', name: 'Landing' },
        ] }) };
      }
      return { ok: true, json: async () => ({ data: { ok: true } }) };
    }));
    await act(async () => { root.render(<TestComp />); });
    // #2093 후속 패턴과 동형 — open=true라야 X-Org-Id 재조회가 돈다(위 describe 참고).
    await act(async () => { result?.setOpen(true); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { result?.setSearchQuery('sprint'); });
    expect(result?.filteredCurrentOrgProjects.map((p) => p.projectName)).toEqual(['Sprintable']);
  });

  it('setOpen(false)로 닫으면 searchQuery가 비워진다(다음 오픈에 지난 검색 안 남음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setSearchQuery('landing'); });
    expect(result?.searchQuery).toBe('landing');
    await act(async () => { result?.setOpen(false); });
    expect(result?.searchQuery).toBe('');
  });

  it('setOpen(true)로 열 때는 searchQuery를 안 건드린다(닫을 때만 초기화)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result?.setSearchQuery('landing'); });
    await act(async () => { result?.setOpen(true); });
    expect(result?.searchQuery).toBe('landing');
  });
});
