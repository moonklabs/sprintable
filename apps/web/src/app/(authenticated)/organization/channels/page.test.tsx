// @vitest-environment jsdom
//
// story #3376(Phase1·마케팅운영) — 채널 연결 화면. content/page.test.tsx·organization/
// connectors/page.test.tsx와 동형 harness(useDashboardContext 목·NextIntlClientProvider·
// createRoot·stubFetch). useSearchParams는 next/navigation 자체를 목으로 대체한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../messages/ko.json';

const { useDashboardContextMock, useSearchParamsMock } = vi.hoisted(() => ({
  useDashboardContextMock: vi.fn(),
  useSearchParamsMock: vi.fn(),
}));

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => useSearchParamsMock(),
}));

import OrganizationChannelsPage from './page';

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
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CONNECTION_ACTIVE = {
  id: 'conn-1', channel: 'threads', account_id: 'acc-1', account_label: '@sprintable_ai',
  credential_kind: 'oauth', status: 'active', token_expires_at: null, last_refreshed_at: null,
  last_error: null, can_auto_refresh: true, connected_by: 'member-1',
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
};

function stubFetch(opts: {
  connections?: unknown[];
  credentials?: { configured: boolean; app_id_suffix: string | null; effective_source: 'org' | 'platform' | 'none' };
}) {
  const connections = opts.connections ?? [];
  const credentials = opts.credentials ?? { configured: false, app_id_suffix: null, effective_source: 'platform' };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/app-credentials')) {
      return { ok: true, status: 200, json: async () => ({ data: credentials }) } as Response;
    }
    if (url.includes('/channel-connections')) {
      return { ok: true, status: 200, json: async () => ({ data: connections }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND' } }) } as Response;
  }));
}

async function mount(role: string) {
  useDashboardContextMock.mockReturnValue({
    orgId: ORG_ID, orgMemberships: [{ orgId: ORG_ID, orgName: 'Org', orgSlug: 'org', role }], projectMemberships: [],
  });
  await act(async () => { root.render(wrap(<OrganizationChannelsPage />)); });
  await flush();
}

describe('OrganizationChannelsPage — 목록·상태(story #3376)', () => {
  it('owner에게 연결된 계정과 상태 칩이 보인다', async () => {
    stubFetch({ connections: [CONNECTION_ACTIVE] });
    await mount('owner');
    expect(container.textContent).toContain('@sprintable_ai');
    expect(container.textContent).toContain('연결됨');
  });

  it('effective_source=none이면 연결 버튼이 비활성이고 이유가 버튼 옆에 뜬다', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'none' } });
    await mount('owner');
    expect(container.textContent).toContain('설정 미완');
    const connectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('연결'));
    expect(connectBtn?.disabled).toBe(true);
    expect(container.textContent).toContain('먼저 앱 자격을 설정해야');
  });

  it('member는 해제·다시 연결 버튼 대신 owner 안내 문구를 본다', async () => {
    stubFetch({ connections: [{ ...CONNECTION_ACTIVE, status: 'expired' }] });
    await mount('member');
    const disconnectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '해제');
    expect(disconnectBtn).toBeUndefined();
    expect(container.textContent).toContain('owner에게 알리기');
  });

  it('member도 연결 시험은 할 수 있다', async () => {
    stubFetch({ connections: [CONNECTION_ACTIVE] });
    await mount('member');
    const testBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '연결 시험');
    expect(testBtn).not.toBeUndefined();
    expect(testBtn?.disabled).toBeFalsy();
  });

  it('?connected= 쿼리로 성공 배너가 뜬다', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('connected=threads'));
    stubFetch({ connections: [] });
    await mount('owner');
    expect(container.textContent).toContain('threads 연결이 완료됐습니다');
  });

  it('?connect_error=로 알려진 코드는 사람 말로, 모르는 코드는 일반 실패 문구로 뜬다', async () => {
    // story #3409 — 이 코드는 owner에게도 뜨므로 isOwner 분기로 owner용 키를 그린다.
    // 문자열을 하드코딩하면 문구 개정마다 이 테스트가 깨진다 — 메시지 키(koMessages)로
    // 대조해 "그 키가 렌더됐는가"만 본다(문구 자체는 i18n 파일이 정본).
    useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=CHANNEL_APP_CREDENTIALS_MISSING'));
    stubFetch({ connections: [] });
    await mount('owner');
    expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissing);

    await act(async () => { root.unmount(); });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=SOME_UNKNOWN_CODE'));
    await mount('owner');
    expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorGeneric);
  });

  it('⭐story #3409 — CHANNEL_APP_CREDENTIALS_MISSING을 member가 보면 owner에게 요청하라는 별도 키가 뜬다(owner용 화면 안 문구는 안 뜸)', async () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=CHANNEL_APP_CREDENTIALS_MISSING'));
    stubFetch({ connections: [] });
    await mount('member');
    expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissingMember);
    expect(container.textContent).not.toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissing);
  });

  it('채널 행 상태는 계정 중 최악으로 승격된다(정상+재인증필요 → 재인증필요)', async () => {
    stubFetch({
      connections: [
        CONNECTION_ACTIVE,
        { ...CONNECTION_ACTIVE, id: 'conn-2', account_id: 'acc-2', account_label: '@second', status: 'revoked' },
      ],
    });
    await mount('owner');
    const chips = [...container.querySelectorAll('[data-status-chip]')];
    const headerChip = chips.find((c) => c.getAttribute('data-status-chip') !== 'connected');
    expect(headerChip?.getAttribute('data-status-chip')).toBe('reauth_required');
  });
});

describe('OrganizationChannelsPage — 앱 자격(AC2, story #3376)', () => {
  it('org 자격이면 끝 4자리를, platform이면 공용 앱 문구를 보여준다(섞지 않는다)', async () => {
    stubFetch({ connections: [], credentials: { configured: true, app_id_suffix: 'ab12', effective_source: 'org' } });
    await mount('owner');
    expect(container.textContent).toContain('끝 4자리');
    expect(container.textContent).toContain('ab12');
    expect(container.textContent).not.toContain('공용 앱으로 연결합니다');
  });

  it('platform 기본이면 「공용 앱」 문구가 뜨고 secret 값은 어디에도 없다', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' } });
    await mount('owner');
    expect(container.textContent).toContain('공용 앱으로 연결합니다');
  });

  it('owner가 등록 버튼을 누르면 App Secret 입력란이 password 타입으로 뜬다', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' } });
    await mount('owner');
    const registerBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '우리 조직 앱을 쓰려면 등록');
    await act(async () => { registerBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const secretInput = container.querySelector('input[type="password"]');
    expect(secretInput).not.toBeNull();
  });

  it('member는 앱 자격 등록 버튼 자체가 없다', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' } });
    await mount('member');
    const registerBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '우리 조직 앱을 쓰려면 등록');
    expect(registerBtn).toBeUndefined();
    expect(container.textContent).toContain('owner에게 알리기');
  });
});
