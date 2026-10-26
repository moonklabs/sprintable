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
// [SID:4681] ③ — the desktop app's bridge (D1 lib/desktop-app): null = a browser (the default for every older test)
const { desktopAppRef } = vi.hoisted(() => ({
  desktopAppRef: { current: null as null | { setProjectFolder: (a: { projectId: string; path: string }) => Promise<{ ok: true } | { problem: string }> } },
}));
vi.mock('@/lib/desktop-app', () => ({ desktopApp: () => desktopAppRef.current ?? undefined }));

let container: HTMLDivElement;
let root: Root;

const ORGS: OrgSwitcherItem[] = [
  // [SID:4681] (PO (나)): an org admin — the grants of the 4681 tests below are allowed; a member's case sets its own orgs
  { orgId: 'org-moonklabs', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' },
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
  desktopAppRef.current = null; // [SID:4681] ③ — a browser unless a test says otherwise
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

  it('⭐story #4226 — switchProject·switchOrgAndProject는 이동 시작 때 «대기 중 목표»를 적는다(커밋 전 탭 링크가 옛 프로젝트를 박지 않게)', async () => {
    const { getPendingProjectTarget, setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    setPendingProjectTarget(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    const pendingAtPush: (string | null)[] = [];
    routerPushMock.mockImplementation(() => { pendingAtPush.push(getPendingProjectTarget()); });
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result?.switchProject('proj-sprintable'); });
    await act(async () => { await result?.switchOrgAndProject('org-dogfood', 'proj-dogfood'); });
    expect(pendingAtPush).toEqual(['proj-sprintable', 'proj-dogfood']);
    routerPushMock.mockReset();
    setPendingProjectTarget(null);
  });

  it('⭐story #4226 — 대기 중 목표는 전환 이동의 transition이 끝나면 해제(주소가 안 바뀌어도 — 같은 URL 이동이 밀어낸 경우)', async () => {
    const { getPendingProjectTarget, setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    setPendingProjectTarget(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    routerPushMock.mockImplementation(() => {}); // 커밋 신호 없음 = 주소 그대로(밀린 이동과 같은 모양)
    try {
      await act(async () => { root.render(<TestComp />); });
      await act(async () => { await result?.switchProject('proj-sprintable'); });
      expect(getPendingProjectTarget()).toBeNull();
    } finally {
      routerPushMock.mockReset();
    }
  });

  it('⭐story #4226 — router.push가 던지면 대기 중 목표를 그 자리서 해제(전역 목표가 남지 않음)', async () => {
    const { getPendingProjectTarget, setPendingProjectTarget } = await import('@/lib/pending-project-switch');
    setPendingProjectTarget(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { ok: true } }) })));
    routerPushMock.mockImplementation(() => { throw new Error('push failed'); });
    try {
      await act(async () => { root.render(<TestComp />); });
      let caught: unknown = null;
      await act(async () => { await result?.switchProject('proj-sprintable').catch((e: unknown) => { caught = e; }); });
      expect((caught as Error | null)?.message).toBe('push failed'); // 호출부로 전파(develop과 같음)
      expect(getPendingProjectTarget()).toBeNull();
    } finally {
      routerPushMock.mockReset();
    }
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

    // 두 번째 시도는 아직 안 끝남 — story 4778: a switch is in the page's one flight now, so an answer that never comes would hold every later switch of this file's module: it is answered at the end
    let answer!: (r: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(async () => new Promise((resolve) => { answer = resolve; })));
    await act(async () => { void result?.switchOrg('org-dogfood'); });
    expect(result?.switchOrgError).toBeNull();
    await act(async () => { answer({ ok: true, json: async () => ({ data: { ok: true } }) }); });
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

// [SID:4681] (D3 · piece ②) — the checked agents get a grant each right after the project is made (POST /api/projects/{id}/access
// {member_id} · 409 = already there = done); a failed grant leaves the project and says the count; no check = no call; the list is
// cleared when the dialog opens and after a make.
describe('useUnifiedSwitcher — 새 프로젝트의 에이전트 접근 grant (story #4681)', () => {
  function stubCreateAndAccess(accessStatus: (memberId: string) => number) {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects' && init?.method === 'POST') return { ok: true, json: async () => ({ data: { id: 'proj-new' } }) };
      const m = /^\/api\/projects\/(.+)\/access$/.exec(url);
      if (m && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { member_id: string };
        calls.push({ url, body });
        const status = accessStatus(body.member_id);
        return { ok: status >= 200 && status < 300, status, json: async () => ({ data: { id: `rec-${body.member_id}` } }) };
      }
      return { ok: true, json: async () => ({ data: { ok: true } }) }; // switch-project · slug
    }));
    return calls;
  }

  it('checked ids → one grant each on the new project, in order; the dialog closes and the switch happens; no notice', async () => {
    const calls = stubCreateAndAccess(() => 201);
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result!.setCreateProjectOpen(true); });
    await act(async () => { result!.setNewProjectAgentIds(['a-1', 'a-2']); });
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: result!.newProjectAgentIds }); });
    expect(calls.map((c) => c.url)).toEqual(['/api/projects/proj-new/access', '/api/projects/proj-new/access']);
    expect(calls.map((c) => (c.body as { member_id: string }).member_id)).toEqual(['a-1', 'a-2']);
    expect((calls[0]!.body as Record<string, unknown>)).toEqual({ member_id: 'a-1', org_member_id: null, permission: 'granted' });
    expect(result!.createProjectOpen).toBe(false);
    expect(result!.createProjectNotice).toBeNull();
    expect(result!.newProjectAgentIds).toEqual([]);
  });

  it('nothing checked → no access call at all (as before this story)', async () => {
    const calls = stubCreateAndAccess(() => 201);
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', ''); });
    expect(calls).toEqual([]);
    expect(result!.createProjectNotice).toBeNull();
  });

  it('409 (already granted) counts as done; a 400 and a thrown fetch count as failed — the project stays, the notice names the count', async () => {
    const calls = stubCreateAndAccess((id) => (id === 'a-dup' ? 409 : id === 'a-bad' ? 400 : 201));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: ['a-ok', 'a-dup', 'a-bad'] }); });
    expect(calls.length).toBe(3);
    expect(result!.createProjectOpen).toBe(false); // the project is real — closed and switched as on success
    expect(result!.createProjectNotice).toBe('프로젝트는 만들었지만 에이전트 1개를 팀에 넣지 못했어요 — 프로젝트 설정 › 접근 권한에서 다시 해 주세요.'); // Yuna §G-3 (4680/4677): «팀에 넣기» · «개» · the tab's own name
    expect(result!.createProjectError).toBeNull();
    // Yuna §F (non-blocking): the notice goes the next time the dialog opens
    await act(async () => { result!.setCreateProjectOpen(true); });
    expect(result!.createProjectNotice).toBeNull();
  });

  it('opening the dialog clears the checked ids (every box off each time)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result!.setNewProjectAgentIds(['a-1']); });
    await act(async () => { result!.setCreateProjectOpen(true); });
    expect(result!.newProjectAgentIds).toEqual([]);
  });

  it('[Kadir codex · PO (나)] an org member (not owner/admin): canGrantAccess is false and no grant is sent even with ids — the server would refuse each one (403) and the notice would name a screen the member cannot open', async () => {
    const calls = stubCreateAndAccess(() => 201);
    const MEMBER_ORGS: OrgSwitcherItem[] = [{ orgId: 'org-moonklabs', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'member' }];
    function MemberComp() {
      const hook = useUnifiedSwitcher({ orgs: MEMBER_ORGS, currentOrgId: 'org-moonklabs', projects: STALE_PROJECTS, currentProjectId: undefined });
      useEffect(() => { result = hook; });
      return null;
    }
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><MemberComp /></NextIntlClientProvider>); });
    expect(result!.canGrantAccess).toBe(false);
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: ['a-1', 'a-2'] }); });
    expect(calls).toEqual([]);
    expect(result!.createProjectOpen).toBe(false); // the project itself is made and switched to, as before
    expect(result!.createProjectNotice).toBeNull();
  });

  it('an org admin: canGrantAccess is true (the list is drawn · the grants go)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(<TestComp />); });
    expect(result!.canGrantAccess).toBe(true);
  });

  it('a failed make (403) grants nothing', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') calls.push(url);
      return { ok: false, status: 403, json: async () => ({}) };
    }));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: ['a-1'] }); });
    expect(calls).toEqual(['/api/projects']);
    expect(result!.createProjectError).toBeTruthy();
  });
});

// [SID:4681] (D3 · piece ③) — the folder picked in the app: sent as the project's `workdir_hint` (text · ①) and kept on this Mac by the
// app (`setProjectFolder`, right after the make, before the grants); not kept (`{problem}` · no app · a throw) = the project stays and
// its own notice says so (Yuna §H — apart from the grants' line); no folder = neither; the folder is dropped when the dialog opens.
describe('useUnifiedSwitcher — 새 프로젝트의 이 컴퓨터 폴더 (story #4681 ③)', () => {
  const FOLDER = '/Users/t/work/결제';
  function stub(accessStatus = 201) {
    const order: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects' && init?.method === 'POST') {
        order.push('make');
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return { ok: true, json: async () => ({ data: { id: 'proj-new' } }) };
      }
      if (/^\/api\/projects\/.+\/access$/.test(url) && init?.method === 'POST') {
        order.push('grant');
        return { ok: accessStatus < 300, status: accessStatus, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ data: { ok: true } }) };
    }));
    const setProjectFolder = vi.fn<(a: { projectId: string; path: string }) => Promise<{ ok: true } | { problem: string }>>(async (a) => { order.push(`keep:${a.projectId}:${a.path}`); return { ok: true as const }; });
    desktopAppRef.current = { setProjectFolder };
    return { order, bodies, setProjectFolder };
  }

  it('a picked folder → workdir_hint in the make · setProjectFolder once with the new id, after the make and before the grants · no notice · the folder is dropped', async () => {
    const s = stub();
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result!.setNewProjectFolder(FOLDER); });
    expect(result!.newProjectFolder).toBe(FOLDER);
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: ['a-1'] }); });
    // PO 5067: the server gets home as `~` (the Mac user's name never leaves this computer) — the app's own hand gets the absolute path
    expect(s.bodies[0]!.workdir_hint).toBe('~/work/결제');
    expect(String(s.bodies[0]!.workdir_hint).startsWith('~/')).toBe(true);
    expect(JSON.stringify(s.bodies[0])).not.toContain('/Users/');
    expect(s.order).toEqual(['make', `keep:proj-new:${FOLDER}`, 'grant']);
    expect(s.setProjectFolder).toHaveBeenCalledWith({ projectId: 'proj-new', path: FOLDER });
    expect(result!.createProjectFolderNotice).toBeNull();
    expect(result!.createProjectNotice).toBeNull();
    expect(result!.newProjectFolder).toBeNull();
    expect(result!.createProjectOpen).toBe(false);
  });

  it('opts.folder wins over the state (the dialog passes what it shows)', async () => {
    const s = stub();
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', '', { folder: '/Users/t/other' }); });
    expect(s.bodies[0]!.workdir_hint).toBe('~/other');
    expect(s.setProjectFolder).toHaveBeenCalledWith({ projectId: 'proj-new', path: '/Users/t/other' });
  });

  it('not kept ({problem} · a throw · no app): the project stays, closed and switched; the folder notice says so (Yuna §H) — and the grants\' line stays its own', async () => {
    const s = stub(400);
    s.setProjectFolder.mockImplementationOnce(async () => ({ problem: 'not_picked' }));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', '', { agentIds: ['a-1'], folder: FOLDER }); });
    expect(result!.createProjectOpen).toBe(false);
    expect(result!.createProjectError).toBeNull();
    expect(result!.createProjectFolderNotice).toBe('프로젝트는 만들었지만 폴더는 이 컴퓨터에 남기지 못했어요 — 에이전트를 시작할 때 앱에서 폴더를 고를 수 있어요.');
    expect(result!.createProjectNotice).toBe('프로젝트는 만들었지만 에이전트 1개를 팀에 넣지 못했어요 — 프로젝트 설정 › 접근 권한에서 다시 해 주세요.');
    // a throw
    const t = stub();
    t.setProjectFolder.mockImplementationOnce(async () => { throw new Error('bridge gone'); });
    await act(async () => { await result!.createProject('결제 개편 2', '', { folder: FOLDER }); });
    expect(result!.createProjectFolderNotice).toBe('프로젝트는 만들었지만 폴더는 이 컴퓨터에 남기지 못했어요 — 에이전트를 시작할 때 앱에서 폴더를 고를 수 있어요.');
    // no app (a folder with no bridge cannot happen from the field — the hook still does not pretend it was kept)
    stub();
    desktopAppRef.current = null;
    await act(async () => { await result!.createProject('결제 개편 3', '', { folder: FOLDER }); });
    expect(result!.createProjectFolderNotice).toBe('프로젝트는 만들었지만 폴더는 이 컴퓨터에 남기지 못했어요 — 에이전트를 시작할 때 앱에서 폴더를 고를 수 있어요.');
    // the next open clears it
    await act(async () => { result!.setCreateProjectOpen(true); });
    expect(result!.createProjectFolderNotice).toBeNull();
  });

  it('no folder: no workdir_hint in the make · setProjectFolder never called (in the app too)', async () => {
    const s = stub();
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', ''); });
    expect('workdir_hint' in s.bodies[0]!).toBe(false);
    expect(s.setProjectFolder).not.toHaveBeenCalled();
    expect(result!.createProjectFolderNotice).toBeNull();
  });

  it('a failed make keeps nothing · opening the dialog drops a picked folder', async () => {
    const s = stub();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { await result!.createProject('결제 개편', '', { folder: FOLDER }); });
    expect(s.setProjectFolder).not.toHaveBeenCalled();
    expect(result!.createProjectFolderNotice).toBeNull();
    await act(async () => { result!.setNewProjectFolder(FOLDER); });
    await act(async () => { result!.setCreateProjectOpen(true); });
    expect(result!.newProjectFolder).toBeNull();
  });
});

// story #4370(유나 판정 (가)) — 새 프로젝트 폼(이름 · 설명 — 설명이 여러 줄 칸)은 조직별 초안: 전환기가 다시 마운트돼도(페이지 이동 ·
// 새로 열기) 남고, 보이는 «취소»(clearNewProjectDraft)와 만들기 성공에서만 지운다. 예전엔 훅 상태라 언마운트면 사라졌다.
describe('useUnifiedSwitcher — 새 프로젝트 폼 초안 (story #4370)', () => {
  async function remount() {
    await act(async () => { root.render(<></>); });
    await act(async () => { root.render(<TestComp />); });
  }

  it('다시 마운트돼도 이름 · 설명이 남고 · clearNewProjectDraft는 지운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result!.setNewProjectName('결제 개편'); });
    await act(async () => { result!.setNewProjectDesc('카드 · 계좌 흐름 정리\n3분기 목표'); });
    await remount();
    expect(result!.newProjectName).toBe('결제 개편');
    expect(result!.newProjectDesc).toBe('카드 · 계좌 흐름 정리\n3분기 목표');
    await act(async () => { result!.clearNewProjectDraft(); });
    await remount();
    expect(result!.newProjectName).toBe('');
    expect(result!.newProjectDesc).toBe('');
  });

  it('만들기 실패는 남기고 · 성공은 지운다', async () => {
    let ok = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/projects' && init?.method === 'POST') return ok ? { ok: true, json: async () => ({ id: 'proj-new' }) } : { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: [] }) };
    }));
    await act(async () => { root.render(<TestComp />); });
    await act(async () => { result!.setNewProjectName('결제 개편'); });
    await act(async () => { result!.setNewProjectDesc('설명'); });
    await act(async () => { await result!.createProject(result!.newProjectName, result!.newProjectDesc); });
    await remount();
    expect(result!.newProjectDesc).toBe('설명');
    ok = true;
    await act(async () => { await result!.createProject(result!.newProjectName, result!.newProjectDesc); });
    await remount();
    expect(result!.newProjectName).toBe('');
    expect(result!.newProjectDesc).toBe('');
  });
});
