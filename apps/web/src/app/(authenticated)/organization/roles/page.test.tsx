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

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
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
  await act(async () => { root.render(wrap(<OrganizationRolesPage />)); });
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
