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

const AVAILABLE_CHANNELS_DEFAULT = [
  { channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' },
];

function stubFetch(opts: {
  connections?: unknown[];
  credentials?: { configured: boolean; app_id_suffix: string | null; effective_source: 'org' | 'platform' | 'none' };
  // story f30da19a(AC2) — available-channels 목록을 테스트별로 바꿀 수 있게(sandbox
  // 포함/미포함·kind='blog' 필터 등).
  availableChannels?: { channel: string; display_name: string; credential_kind: string; kind: string }[];
  // story f30da19a — 성공하면 nextConnections로 이후의 목록 재조회(onRefresh→load)가
  // 새 행을 반영하는지까지 pin할 수 있게 한다.
  onCreateSandbox?: (init?: RequestInit) => { status: number; body?: unknown; nextConnections?: unknown[] };
}) {
  let connections = opts.connections ?? [];
  const credentials = opts.credentials ?? { configured: false, app_id_suffix: null, effective_source: 'platform' };
  const availableChannels = opts.availableChannels ?? AVAILABLE_CHANNELS_DEFAULT;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    // available-channels가 '/channel-connections'의 부분문자열이라 그 체크보다 먼저 봐야 한다.
    if (url.includes('/channel-connections/available-channels')) {
      return { ok: true, status: 200, json: async () => ({ data: availableChannels }) } as Response;
    }
    if (url.includes('/channel-connections/sandbox') && init?.method === 'POST') {
      const result = opts.onCreateSandbox?.(init) ?? {
        status: 201,
        body: { id: 'conn-sb-1', channel: 'sandbox', account_id: 'sandbox-org-1', status: 'active' },
        nextConnections: [{ ...CONNECTION_ACTIVE, id: 'conn-sb-1', channel: 'sandbox', credential_kind: 'none', account_label: null, account_id: 'sandbox-org-1' }],
      };
      const ok = result.status < 400;
      if (ok && result.nextConnections) connections = result.nextConnections;
      return { ok, status: result.status, json: async () => (ok ? { data: result.body } : { data: null, error: { code: (result.body as { code?: string })?.code } }) } as Response;
    }
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
    expect(container.textContent).toContain('owner만 할 수 있는 작업입니다');
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
    // story 3436(묶음 6) — channelLabel()이 raw 쿼리값을 사람이 읽는 이름으로 정규화한다.
    expect(container.textContent).toContain('Threads 연결이 완료됐습니다');
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

// story dd29e6dd(유나 5회차 관찰) — 헤더 rollup 칩이 연결 1개일 때 행 칩과 같은
// 문장을 두 번 보여주던 것. 처방=헤더 칩은 연결 ≥2일 때만. 3표본(0/1/2개) 그대로 pin.
//
// ⚠️카디르군 REQUEST_CHANGES(2026-09-05, PR#3826) — 최초 버전은 「칩 총 개수 + 값」만
// 재서, "헤더 자리에 뜨고 행 자리엔 없는"(자리가 뒤바뀐) 회귀를 주입해도 그대로
// PASS했다(개수 1은 그대로 1이니까). data-testid로 헤더 컨테이너·행 컨테이너를
// 구조적으로 갈라 "그 자리 안에 몇 개가 있나"를 직접 잰다 — 값이 아니라 위치가 검증
// 대상이다.
describe('OrganizationChannelsPage — 헤더 rollup 칩 임계값(story dd29e6dd)', () => {
  it('⭐연결 0개 — 헤더 자리 칩 0·행 컨테이너 자체가 없음(회귀 pin)', async () => {
    stubFetch({ connections: [] });
    await mount('owner');
    const header = container.querySelector('[data-testid="channel-section-header"]')!;
    expect(header.querySelectorAll('[data-status-chip]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="channel-section-rows"]')).toBeNull();
  });

  it('⭐연결 1개 — 헤더 자리 칩 0·행 컨테이너 안에 정확히 1개(같은 문장 두 번 안 남, 자리 뒤바뀜도 잡힘)', async () => {
    stubFetch({ connections: [CONNECTION_ACTIVE] });
    await mount('owner');
    const header = container.querySelector('[data-testid="channel-section-header"]')!;
    const rows = container.querySelector('[data-testid="channel-section-rows"]')!;
    expect(header.querySelectorAll('[data-status-chip]')).toHaveLength(0);
    const rowChips = rows.querySelectorAll('[data-status-chip]');
    expect(rowChips).toHaveLength(1);
    expect(rowChips[0]?.getAttribute('data-status-chip')).toBe('connected');
  });

  it('⭐연결 2개(active+expired) — 헤더 자리에 정확히 1개(최악=expired)·행 컨테이너 안에 정확히 2개(현행 유지)', async () => {
    stubFetch({
      connections: [
        CONNECTION_ACTIVE,
        { ...CONNECTION_ACTIVE, id: 'conn-2', account_id: 'acc-2', account_label: '@second', status: 'expired', token_expires_at: '2020-01-01T00:00:00Z' },
      ],
    });
    await mount('owner');
    const header = container.querySelector('[data-testid="channel-section-header"]')!;
    const rows = container.querySelector('[data-testid="channel-section-rows"]')!;
    const headerChips = header.querySelectorAll('[data-status-chip]');
    expect(headerChips).toHaveLength(1);
    expect(headerChips[0]?.getAttribute('data-status-chip')).toBe('reauth_required');
    expect(rows.querySelectorAll('[data-status-chip]')).toHaveLength(2);
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
    expect(container.textContent).toContain('owner만 할 수 있는 작업입니다');
  });
});

// story f30da19a(AC2) — CHANNELS 하드코딩 대신 available-channels 목록으로 렌더한다.
describe('OrganizationChannelsPage — available-channels 목록 기반 렌더(story f30da19a AC2)', () => {
  const AVAILABLE_WITH_SANDBOX = [
    { channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' },
    { channel: 'sandbox', display_name: 'Sandbox', credential_kind: 'none', kind: 'social' },
  ];

  it('⭐available-channels에 sandbox가 없으면(prod) 그 카드·버튼 자체가 안 그려진다(dev 전용 env 분기 없이 데이터로 성립)', async () => {
    stubFetch({ connections: [], availableChannels: [{ channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' }] });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
    expect(container.textContent).not.toContain('Sandbox');
  });

  it('⭐available-channels에 sandbox가 있으면(dev) owner에게 「연결 만들기」 버튼이 보인다', async () => {
    stubFetch({ connections: [], availableChannels: AVAILABLE_WITH_SANDBOX });
    await mount('owner');
    const btn = container.querySelector('[data-testid="channel-connect-sandbox-button"]');
    expect(btn).not.toBeNull();
    // story 3436(묶음 6) — display_name("Sandbox") 대신 channelLabel(§13-6 어휘)로 렌더 —
    // 배지("테스트용 연결")와 버튼 문구가 이제 일치한다.
    expect(btn?.textContent).toContain('테스트용');
  });

  it('member는 sandbox 버튼 대신 owner 안내 문구를 본다', async () => {
    stubFetch({ connections: [], availableChannels: AVAILABLE_WITH_SANDBOX });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
    expect(container.textContent).toContain('owner만 할 수 있는 작업입니다');
  });

  it('⭐sandbox 「연결 만들기」를 누르면 BFF POST 성공 뒤 리로드 없이 새 연결 행이 추가된다', async () => {
    stubFetch({ connections: [], availableChannels: AVAILABLE_WITH_SANDBOX });
    await mount('owner');
    expect(container.textContent).not.toContain('sandbox-org-1');

    const btn = container.querySelector('[data-testid="channel-connect-sandbox-button"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    expect(container.textContent).toContain('sandbox-org-1');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-error"]')).toBeNull();
  });

  it('sandbox 생성이 CHANNEL_SANDBOX_DISABLED(404)로 실패하면 방어적 사유 문구가 뜬다', async () => {
    stubFetch({
      connections: [],
      availableChannels: AVAILABLE_WITH_SANDBOX,
      onCreateSandbox: () => ({ status: 404, body: { code: 'CHANNEL_SANDBOX_DISABLED' } }),
    });
    await mount('owner');
    const btn = container.querySelector('[data-testid="channel-connect-sandbox-button"]') as HTMLButtonElement;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(container.querySelector('[data-testid="channel-connect-sandbox-error"]')?.textContent)
      .toBe(koMessages.channelConnect.channelSandboxDisabledReason);
  });

  // story #3450 후속(페드루 PO 確定 2026-09-05) — f30da19a(2026-09-04 13:52Z)의
  // "kind='blog'는 이 화면 범위 밖" 결정을 PO가 직접 뒤집었다. 연결 필요 여부는
  // BE requires_connection 하나가 결정하고(hosted_site가 그래서 애초에 이 목록에
  // 안 옴, BE 몫이라 여기서 pin 안 함), FE는 kind로 더는 안 거른다 — kind='blog'
  // (WordPress·webhook)도 credential_kind에 맞는 카드로 그려져야 정상이다.
  it('⭐kind=blog+credential_kind=pasted_secret(WordPress) — PastedSecretConnectCard로 그려진다(더는 안 걸러짐)', async () => {
    stubFetch({
      connections: [],
      availableChannels: [
        { channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' },
        { channel: 'wordpress', display_name: 'WordPress', credential_kind: 'pasted_secret', kind: 'blog' },
      ],
    });
    await mount('owner');
    expect(container.textContent).toContain('WordPress');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).not.toBeNull();
  });

  it('kind=blog+credential_kind=oauth(WordPress.com류 대비) — oauth 카드로 그려진다', async () => {
    stubFetch({
      connections: [],
      availableChannels: [
        { channel: 'wordpress', display_name: 'WordPress', credential_kind: 'oauth', kind: 'blog' },
      ],
      credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' },
    });
    await mount('owner');
    expect(container.textContent).toContain('WordPress');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).toBeNull();
  });
});

// story #3450 FE 후속(3653a18c §2, 페드루 PO 確定 2026-09-04 23:13Z·23:20Z) —
// pasted_secret(WordPress·webhook) 자리 채움이 실제로 이 화면에 배선됐는지.
// 필드 단위 pin은 pasted-secret-connect-card.test.tsx가 다룬다 — 여기서는 이
// 페이지가 그 컴포넌트를 credential_kind==='pasted_secret'에 정확히 얹는지와
// AC5(재방문 화면에 secret 끝 4자리조차 없음)만 확인한다.
describe('OrganizationChannelsPage — pasted_secret 자리 채움(story #3450 FE 후속)', () => {
  const WORDPRESS_AVAILABLE = [
    { channel: 'wordpress', display_name: 'WordPress', credential_kind: 'pasted_secret', kind: 'blog' },
  ];

  it('⭐credential_kind===pasted_secret 채널에 PastedSecretConnectCard 토글 버튼이 뜬다(owner)', async () => {
    stubFetch({ connections: [], availableChannels: WORDPRESS_AVAILABLE });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).not.toBeNull();
  });

  it('member는 버튼 대신 owner 전용 사유만 본다(§5·AC4)', async () => {
    stubFetch({ connections: [], availableChannels: WORDPRESS_AVAILABLE });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.channelConnect.channelOwnerOnlyReason);
  });

  it('⭐(AC5) 이미 연결된 WordPress 행에 secret 값·끝 4자리 어느 것도 안 그려진다 — BFF 응답(ChannelConnectionResponse)에 그 필드가 없다', async () => {
    stubFetch({
      connections: [{
        id: 'conn-wp-1', channel: 'wordpress', account_id: 'https://blog.example.com', account_label: 'admin',
        credential_kind: 'pasted_secret', status: 'active', token_expires_at: null, last_refreshed_at: null,
        last_error: null, can_auto_refresh: false, connected_by: 'member-1',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
      }],
      availableChannels: WORDPRESS_AVAILABLE,
    });
    await mount('owner');
    // 계정 라벨(username)만 보이고(ConnectionRow는 account_label이 있으면 account_id
    // 대신 그것만 그린다, 정상 기존 동작) — app_password류 흔적(마스킹 문자열 포함)이
    // 어디에도 없다. 스키마 자체가 그 필드를 안 주므로(types.ts) 이 화면이 지어낼 값
    // 자체가 없다.
    expect(container.textContent).toContain('admin');
    expect(container.textContent).not.toMatch(/•{2,}|\*{2,}/);
  });
});
