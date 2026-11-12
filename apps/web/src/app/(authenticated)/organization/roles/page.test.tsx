// @vitest-environment jsdom
//
// story #3231(카디르 버그사냥) — 이 페이지가 role 무관하게 email 포함 전체 로스터를
// 항상 렌더해, 일반 Member도 조직 전원의 실명+이메일을 볼 수 있었다. BE(GET
// /api/v2/org-members)를 admin/owner 전용 403으로 잠근 것이 실 정본 — 여기서는 FE가
// Member 신분엔 그 fetch 자체를 안 쏘고(헛된 403 방지, events/page.test.tsx와 동일
// 컨벤션) 안내 문구만 보여주는지, admin/owner는 무회귀인지 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// 4913 — 화면 제목은 앱 틀 위 막대(TopBarSlot)로 간다: 막대 자리를 이 프로브가 그려 본문과 같은 문서에서 h1을 센다.
// (afterEach가 모듈을 비우므로 막대 컨텍스트도 화면과 같은 번에 불러온다 — 따로 정적으로 불러오면 컨텍스트가 둘이 된다.)
async function wrap(node: React.ReactNode) {
  const { TopBarProvider, useTopBar } = await import('@/components/nav/top-bar-context');
  function TopBarTitleProbe() {
    const { title } = useTopBar();
    return <div data-testid="topbar-probe">{title}</div>;
  }
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider><TopBarTitleProbe />{node}</TopBarProvider>
    </NextIntlClientProvider>
  );
}

const ORG_ID = 'org-1';

function asRole(role: 'owner' | 'admin' | 'member') {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role }],
    projectMemberships: [],
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  asRole('admin');
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: OrganizationRolesPage } = await import('./page');
  const tree = await wrap(<OrganizationRolesPage />);
  await act(async () => { root.render(tree); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('OrganizationRolesPage — Member 신분엔 관리자 전용 안내(story #3231)', () => {
  it('member — 안내 문구만 뜨고 email 포함 로스터 fetch 자체를 안 쏜다', async () => {
    asRole('member');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    expect(container.textContent).toContain(koMessages.organization.rolesAdminOnly);
    expect(container.textContent).toContain(koMessages.organization.rolesAdminOnlyHint);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admin — 무회귀, 기존처럼 그룹별 로스터가 정상 렌더된다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'm-1', name: '오너 하나', email: 'owner@moonklabs.com', role: 'owner' },
              { id: 'm-2', name: '멤버 둘', email: 'member@moonklabs.com', role: 'member' },
            ],
          }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    expect(container.textContent).not.toContain(koMessages.organization.rolesAdminOnly);
    expect(container.textContent).toContain('오너 하나');
    expect(container.textContent).toContain('멤버 둘');
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/org-members')).toBe(true);
  });

  it('owner — member 신분과 달리 정상 접근된다(admin과 동일 경계)', async () => {
    asRole('owner');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    expect(container.textContent).not.toContain(koMessages.organization.rolesAdminOnly);
    expect(fetchMock).toHaveBeenCalled();
  });
});

// story #3491(페드루 PO 確定) — FE 게이트를 BE 인가 폭(owner·admin)과 맞춘다.
describe('OrganizationRolesPage — 역할 변경 게이트가 BE 인가 폭과 같다(story #3491)', () => {
  it('⭐admin caller — owner도 자기 자신도 아닌 member 행엔 <select>가 뜬다(FE=BE 폭 정정의 핵심)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'row-owner', user_id: 'u-owner', name: '오너', role: 'owner' },
              { id: 'row-self', user_id: 'u-admin-self', name: '나', role: 'admin' },
              { id: 'row-other', user_id: 'u-member', name: '멤버', role: 'member' },
            ],
          }),
        };
      }
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u-admin-self' } }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    const selects = container.querySelectorAll('select');
    expect(selects.length).toBe(1); // owner 행·자기 자신 행은 select가 없다.
  });

  it('⭐<select>엔 owner 옵션이 없다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return { ok: true, json: async () => ({ data: [{ id: 'row-other', user_id: 'u-member', name: '멤버', role: 'member' }] }) };
      }
      if (url === '/api/me') return { ok: true, json: async () => ({ data: { user_id: 'u-admin-self' } }) };
      throw new Error('unexpected fetch: ' + url);
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    const select = container.querySelector('select')!;
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['admin', 'member']);
  });
});

// [SID:4286] 이름 없는 구성원의 이름 칸 — 이메일 앞부분 · user_id 조각 · 날것 «?»를 지어내지 않고 «이름 없는 구성원».
describe('OrganizationRolesPage — 이름 칸 폴백(story #4286)', () => {
  it('⭐name null — 이름 칸은 «이름 없는 구성원» · 이메일 앞부분/user_id 조각/«?» 0(이메일은 제 줄에만)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/org-members') {
        return {
          ok: true,
          json: async () => ({ data: [{ id: 'm-3', user_id: 'u-abcdef123456', name: null, email: 'noname@moonklabs.com', role: 'member' }] }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    }));
    await mount();
    const nameCells = Array.from(container.querySelectorAll('[data-slot="ds-list-row"] div.font-semibold')).map((el) => el.textContent ?? '');
    expect(nameCells).toContain(koMessages.common.memberUnnamed);
    expect(nameCells).not.toContain('noname');
    expect(nameCells).not.toContain('?');
    expect(container.textContent).not.toContain('u-abcdef');
    expect(container.textContent).toContain('noname@moonklabs.com');
  });
});

// 4913(UI-R5 · 한 쪽 틀 A판) — 제목은 위 막대 한 곳, 본문은 틀 안에서 시작하고, 모든 분기에서 머리가 남는다.
describe('OrganizationRolesPage — 한 쪽 틀(4913)', () => {
  const roster = { ok: true, json: async () => ({ data: [{ id: 'm-1', user_id: 'u-1', name: '오너 하나', email: 'o@x.com', role: 'owner' }] }) };

  it('⭐admin — h1이 정확히 1개(위 막대 제목) · 본문은 reading 틀 안 · 본문에 h1을 따로 안 그린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roster));
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('[data-testid="topbar-probe"] h1')?.textContent).toBe(koMessages.organization.rolesTitle);
    const frame = container.querySelector('[data-slot="ds-page-frame"]');
    expect(frame?.getAttribute('data-width')).toBe('reading');
    expect(frame?.querySelector('h1')).toBeNull();
    expect(frame?.querySelector('[data-slot="ds-page-head"]')?.textContent).toContain(koMessages.organization.rolesDescription);
  });

  it('⭐member(권한 없음 분기) — 위 막대 제목이 남는다(예전엔 이 분기에서 머리가 사라졌다) · 안내는 EmptyState', async () => {
    asRole('member');
    vi.stubGlobal('fetch', vi.fn(async () => roster));
    await mount();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('[data-testid="topbar-probe"] h1')?.textContent).toBe(koMessages.organization.rolesTitle);
    expect(container.querySelector('[data-slot="ds-empty-state"]')?.textContent).toContain(koMessages.organization.rolesAdminOnly);
  });

  it('⭐불러오는 중 분기 — 위 막대 제목이 남는다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { default: OrganizationRolesPage } = await import('./page');
    const tree = await wrap(<OrganizationRolesPage />);
  await act(async () => { root.render(tree); });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelector('[data-slot="ds-page-frame"]')).not.toBeNull();
  });

  it('구획 셋(소유자 · 관리자 · 구성원)이 RowList이고 구획 머리에 건수가 붙는다 · 빈 구획은 inline 빈 상태', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roster));
    await mount();
    const lists = container.querySelectorAll('[data-slot="ds-row-list"]');
    expect(lists).toHaveLength(3);
    expect(lists[0]!.querySelector('[data-slot="ds-section-header"]')?.textContent).toContain('1');
    expect(lists[1]!.querySelector('[data-slot="ds-empty-state"]')?.getAttribute('data-size')).toBe('inline');
  });

  it('⭐빈 구획의 건수 0도 그려진다(0은 거짓값이라 빠지던 길 · 옛 CountBadge는 늘 그렸다) · 구획 제목은 h2(옛 화면과 같은 단계)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => roster));
    await mount();
    const lists = container.querySelectorAll('[data-slot="ds-row-list"]');
    expect(lists[1]!.querySelector('[data-slot="ds-section-header"]')?.textContent).toContain('0');
    expect(lists[2]!.querySelector('[data-slot="ds-section-header"]')?.textContent).toContain('0');
    expect([...container.querySelectorAll('[data-slot="ds-section-header"]')].every((h) => h.querySelector('h2'))).toBe(true);
  });
});
