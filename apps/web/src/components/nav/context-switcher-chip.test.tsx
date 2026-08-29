// @vitest-environment jsdom
//
// story #2076 — top-bar 좌상단 컨텍스트 칩(<1024). 현재 조직/프로젝트를 상시 표시하고 탭하면
// 전환 바텀시트가 열리는 것, 그리고 프로젝트 선택 시 useUnifiedSwitcher(사이드바와 동일 훅)의
// switchProject가 정확히 호출되는 것을 실제 DOM(createRoot)으로 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ContextSwitcherChip } from './context-switcher-chip';
import koMessages from '../../../messages/ko.json';

const pushMock = vi.fn();
const refreshMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  usePathname: () => '/moonklabs/sprintable/board',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/create-organization-dialog', () => ({
  CreateOrganizationDialog: () => null,
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

const ORGS = [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'admin' }];
const PROJECTS = [
  { projectId: 'proj-1', projectName: 'Sprintable' },
  { projectId: 'proj-2', projectName: 'Landing' },
];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pushMock.mockClear();
  refreshMock.mockClear();
  // story #2093 후속 — 시트가 열리면 useUnifiedSwitcher가 현재 org도 X-Org-Id로 재조회한다
  // (JWT 스코프 stale 방지). 이 스위트는 URL org(org-1)=계정 상태 org라 재조회 결과가 그대로
  // PROJECTS와 같아야 한다 — 아니면 재조회가 목록을 빈 배열로 덮어써 이후 단언이 깨진다.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ data: PROJECTS.map((p) => ({ id: p.projectId, name: p.projectName })) }) };
    }
    return { ok: true, json: async () => ({ data: { ok: true } }) };
  }));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ContextSwitcherChip — story #2076', () => {
  it('현재 조직›프로젝트를 라벨로 표시하고 lg:hidden(≥1024에서 숨김)이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    expect(trigger?.textContent).toContain('뭉클랩');
    expect(trigger?.textContent).toContain('Sprintable');
    expect(trigger?.className).toContain('lg:hidden');
  });

  it('긴급 fix(채팅 리스트 재현) — max-w가 뷰포트 비례(vw)가 아닌 고정 px 캡이다', async () => {
    // max-w-[55vw]는 title+actions 있는 allowlist 화면(채팅·목표 등)에서 아이콘 클러스터와
    // 합쳐 <1024 뷰포트를 82px 초과했다(실측, 2076 회귀 후속) — 고정 px 캡으로 되돌아가는
    // 회귀를 막는다.
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    expect(trigger?.className).not.toMatch(/max-w-\[\d+vw\]/);
    expect(trigger?.className).toMatch(/max-w-\[\d+px\]/);
  });

  it('칩을 탭하기 전에는 프로젝트 목록(바텀시트 내용)이 안 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    expect(document.body.textContent).not.toContain('Landing');
  });

  it('칩을 탭하면 바텀시트가 열려 프로젝트 목록이 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain('Landing');
  });

  it('시트에서 다른 프로젝트를 선택하면 switchProject 경로(fetch /api/switch-project)가 호출된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const landingButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Landing'));
    await act(async () => {
      landingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/switch-project',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ project_id: 'proj-2' }) }),
    );
  });
});

// story #3147(doc mobile-switcher-redesign-spec-4758744a, 유나 확定 규격) — 선생님 실사용
// 발견 6결함 해소: 44px 트리거+행·검색·3층 위계(프로젝트→조직→계정)·계정 divider 분리·
// 데스크톱 무회귀.
describe('ContextSwitcherChip — story #3147/#3146 재설계(44px·검색·3층·계정)', () => {
  it('트리거가 h-11(44px 고정)이고 조직/프로젝트 2줄로 표시된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    // story #3202(선생님 실기기 픽셀 붕괴) 핀 — min-h-11(최솟값)이던 시절엔 2단 라벨의
    // line-height가 예산을 넘기면 트리거 실높이가 부모 TopBar(h-12=48px)를 초과해 자기
    // border/bg가 헤더 행을 뚫고 나온 것처럼 보였다(dev 라이브 실측: 48.5px·상단 -0.75px로
    // 실제 초과 확認). h-11(고정 44px)+overflow-hidden으로 어떤 폰트 렌더링에서도 그 예산을
    // 못 넘게 하드캡한다 — min-h-11 회귀(다시 growable해지는 것)를 여기서 막는다.
    expect(trigger?.className).toContain('h-11');
    expect(trigger?.className).not.toContain('min-h-11');
    expect(trigger?.className).toContain('overflow-hidden');
    const spans = trigger!.querySelectorAll('span > span');
    expect(spans[0]?.textContent).toBe('뭉클랩');
    expect(spans[1]?.textContent).toBe('Sprintable');
    // 두 라벨 span 모두 leading-none(타이트 line-height)로 실높이 예산을 하드캡 — 안드로이드
    // 폰트 부스트 등 렌더링 조건과 무관하게 44px 안에 들어오게 하는 축.
    expect(spans[0]?.className).toContain('leading-none');
    expect(spans[1]?.className).toContain('leading-none');
  });

  it('시트 안 프로젝트 행이 min-h-11(44px)이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const landingButton = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Landing'));
    expect(landingButton?.className).toContain('min-h-11');
  });

  it('검색 입력이 현재 조직 프로젝트를 즉시 필터한다(9+ 대응)', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain('Landing');

    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'Sprint');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Sprintable');
    expect(document.body.textContent).not.toContain('Landing');
  });

  it('검색어와 일치하는 프로젝트가 없으면 빈 상태 문구가 뜬다(지어낸 목록 없음)', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, '존재하지않는프로젝트이름');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 트리거 자신도 현재 프로젝트명("Sprintable")을 상시 표시하므로 document.body 전체가
    // 아니라 시트 스크롤 본문(overflow-y-auto)으로 좁혀 잰다.
    const sheetBody = document.querySelector('.overflow-y-auto');
    expect(sheetBody?.textContent).toContain('일치하는 프로젝트가 없습니다');
    expect(sheetBody?.textContent).not.toContain('Sprintable');
  });

  it('다른 조직이 있으면 「다른 조직」 섹션 라벨이 뜬다', async () => {
    const orgsWithOther = [...ORGS, { orgId: 'org-2', orgName: 'E2E Test Corp', orgSlug: 'e2e', role: 'owner' }];
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={orgsWithOther} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).toContain('다른 조직');
    expect(document.body.textContent).toContain('E2E Test Corp');
  });

  it('userName 없으면 계정층 자체가 생략된다(no-fiction — 빈 계정 UI로 지어내지 않음)', async () => {
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.textContent).not.toContain('계정 추가');
  });

  it('userName 있으면 계정층(divider+계정 라벨+현재 계정+계정 추가+로그아웃)이 뜬다(#73d5ff10 해소)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ data: PROJECTS.map((p) => ({ id: p.projectId, name: p.projectName })) }) };
      }
      if (url === '/api/accounts') {
        return { ok: true, json: async () => ({ data: { accounts: [
          { account_id: 'a1', name: '송윤재', email: 'sellerking@moonklabs.com', org_name: null, avatar_url: null, status: 'active' },
        ] } }) };
      }
      return { ok: true, json: async () => ({ data: { ok: true } }) };
    }));
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" userName="송윤재" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const sheetBody = document.querySelector('.overflow-y-auto');
    expect(sheetBody?.textContent).toContain('계정');
    expect(sheetBody?.textContent).toContain('송윤재');
    expect(sheetBody?.textContent).toContain('계정 추가');
    expect(sheetBody?.textContent).toContain('로그아웃');
  });

  it('계정 전환 클릭 시 /api/auth/switch-account가 호출된다(profile-menu.tsx와 동일 배선 재사용)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') {
        return { ok: true, json: async () => ({ data: PROJECTS.map((p) => ({ id: p.projectId, name: p.projectName })) }) };
      }
      if (url === '/api/accounts') {
        return { ok: true, json: async () => ({ data: { accounts: [
          { account_id: 'a1', name: '송윤재', email: null, org_name: null, avatar_url: null, status: 'active' },
          { account_id: 'a2', name: '부계정', email: null, org_name: null, avatar_url: null, status: 'inactive' },
        ] } }) };
      }
      return { ok: true, json: async () => ({ data: { ok: true } }) };
    }));
    vi.stubGlobal('location', { assign: vi.fn() } as unknown as Location);
    await act(async () => {
      root.render(wrap(
        <ContextSwitcherChip orgs={ORGS} currentOrgId="org-1" projects={PROJECTS} currentProjectId="proj-1" userName="송윤재" />,
      ));
    });
    const trigger = container.querySelector('button');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const otherAccountBtn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('부계정'));
    expect(otherAccountBtn).toBeTruthy();
    await act(async () => { otherAccountBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/switch-account', expect.objectContaining({ method: 'POST' }));
  });
});
