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

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
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
