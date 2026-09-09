// @vitest-environment jsdom
//
// story #3737(D1, 유나 定 2026-09-09) — 신뢰 센터 그룹 제목 「구현 (4)」의 「구현」은
// BE role_label(그라운딩 확인, ParticipationRole 시드)이라 코드 키 누출이 아니다 — 진짜
// 결함은 E절(수를 제목 문자열 안에 넣는 형) 위반뿐. 제목 고정+수는 배지로 분리한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

import OrganizationTrustPage from './page';

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

beforeEach(() => {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID,
    orgMemberships: [{ orgId: ORG_ID, orgName: 'Org', orgSlug: 'org', role: 'admin' }],
    projectMemberships: [], projectId: 'proj-1', currentTeamMemberId: 'member-1',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function stubFetch(members: Array<{ member_id: string; role_key: string; role_label: string | null; hit_rate: number | null; resolved: number | null; computed_at: string }>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/trust-scores/org-summary') {
      return { ok: true, status: 200, json: async () => ({ members }) };
    }
    if (url === '/api/org-members') {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (url.startsWith('/api/team-members')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    throw new Error('unexpected fetch: ' + url);
  }));
}

describe('OrganizationTrustPage(story #3737 D1)', () => {
  it('⭐그룹 제목은 role_label 고정 문자열, 수는 별도 배지(수를 제목 문자열 안에 안 넣는다)', async () => {
    stubFetch([
      { member_id: 'm1', role_key: 'implementation', role_label: '구현', hit_rate: 0.9, resolved: 5, computed_at: '2026-09-09T00:00:00Z' },
      { member_id: 'm2', role_key: 'implementation', role_label: '구현', hit_rate: 0.8, resolved: 4, computed_at: '2026-09-09T00:00:00Z' },
    ]);
    await act(async () => { root.render(wrap(<OrganizationTrustPage />)); });
    await flush();

    const heading = container.querySelector('h2');
    expect(heading).not.toBeNull();
    // 제목 문자열 자체엔 수가 없다("구현 (2)"처럼 붙어 있으면 회귀).
    expect(heading?.textContent).not.toMatch(/\(\d+\)/);
    const badge = heading?.querySelector('[data-slot="badge"]') ?? heading?.querySelector('span');
    expect(badge?.textContent).toBe('2');
  });
});
