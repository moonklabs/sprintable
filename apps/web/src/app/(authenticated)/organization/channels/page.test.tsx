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
  // story #3504 — 해제 실패 표면화 검증용.
  disconnectStatus?: number;
  disconnectErrorCode?: string;
  // story #3540 — 「성과 수집」 섹션. 기본값은 빈 배열(섹션 자체가 안 뜬다, 기존
  // 테스트 전부 회귀 0). measurementLoadFails=true면 GET 자체가 실패.
  measurementConnections?: {
    key: 'beacon' | 'utm' | 'ga4'; status: string; last_seen_at: string | null; count_7d: number | null;
    settings_path: string | null; property_id?: string | null; property_name?: string | null;
  }[];
  measurementLoadFails?: boolean;
  onMeteringKey?: () => { status: number; body?: unknown };
  // story #3549 — Facebook Page 「선택 대기」 select 호출.
  onFacebookSelect?: (body: unknown) => { status: number; body: unknown; nextConnections?: unknown[] };
  // story #3583 — GA4 인증/속성 목록/속성 선택/해제. select·disconnect 성공 뒤
  // onRefresh()가 다시 부르는 GET이 새 상태를 보게 하려면 nextMeasurementConnections로
  // 교체한다(onFacebookSelect의 nextConnections와 같은 관례).
  onGa4Authorize?: () => { status: number; body?: unknown };
  ga4Properties?: { property_id: string; display_name: string }[];
  ga4PropertiesFails?: boolean;
  onGa4Select?: (body: unknown) => { status: number; body?: unknown; nextMeasurementConnections?: unknown[] };
  onGa4Disconnect?: () => { status: number; nextMeasurementConnections?: unknown[] };
}) {
  let connections = opts.connections ?? [];
  const credentials = opts.credentials ?? { configured: false, app_id_suffix: null, effective_source: 'platform' };
  const availableChannels = opts.availableChannels ?? AVAILABLE_CHANNELS_DEFAULT;
  let measurementConnections = opts.measurementConnections ?? [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    // story #3583 — GA4 하위 경로가 '/measurement-connections'의 부분문자열이라
    // 그 체크보다 먼저 봐야 한다(available-channels/channel-connections와 같은 순서 규율).
    if (url.includes('/measurement-connections/ga4/authorize') && init?.method === 'POST') {
      const result = opts.onGa4Authorize?.() ?? { status: 200, body: { authorize_url: 'https://accounts.google.com/o/oauth2/mock' } };
      const ok = result.status < 400;
      return { ok, status: result.status, json: async () => (ok ? { data: result.body } : { data: null, error: { code: 'INTERNAL' } }) } as Response;
    }
    if (url.includes('/measurement-connections/ga4/properties')) {
      if (opts.ga4PropertiesFails) return { ok: false, status: 500, json: async () => ({ data: null, error: { code: 'INTERNAL' } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ data: opts.ga4Properties ?? [] }) } as Response;
    }
    if (url.includes('/measurement-connections/ga4/select') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      const result = opts.onGa4Select?.(body) ?? { status: 200, body: { ok: true } };
      const ok = result.status < 400;
      if (ok && result.nextMeasurementConnections) measurementConnections = result.nextMeasurementConnections as typeof measurementConnections;
      return { ok, status: result.status, json: async () => (ok ? { data: result.body } : { data: null, error: { code: 'INTERNAL' } }) } as Response;
    }
    if (url.includes('/measurement-connections/ga4') && init?.method === 'DELETE') {
      const result = opts.onGa4Disconnect?.() ?? { status: 200 };
      const ok = result.status < 400;
      if (ok && result.nextMeasurementConnections) measurementConnections = result.nextMeasurementConnections as typeof measurementConnections;
      return { ok, status: result.status, json: async () => (ok ? { data: { ok: true } } : { data: null, error: { code: 'INTERNAL' } }) } as Response;
    }
    if (url.includes('/measurement-connections')) {
      if (opts.measurementLoadFails) return { ok: false, status: 500, json: async () => ({ data: null, error: { code: 'INTERNAL' } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ data: measurementConnections }) } as Response;
    }
    if (url.includes('/metering-key')) {
      const result = opts.onMeteringKey?.() ?? { status: 200, body: { public_key: 'pk_test_1234567890' } };
      const ok = result.status < 400;
      return { ok, status: result.status, json: async () => (ok ? { data: result.body } : { data: null, error: { code: 'INTERNAL' } }) } as Response;
    }
    // available-channels가 '/channel-connections'의 부분문자열이라 그 체크보다 먼저 봐야 한다.
    if (url.includes('/channel-connections/available-channels')) {
      return { ok: true, status: 200, json: async () => ({ data: availableChannels }) } as Response;
    }
    if (url.includes('/disconnect') && init?.method === 'POST') {
      const status = opts.disconnectStatus ?? 200;
      const ok = status < 400;
      return {
        ok, status,
        json: async () => (ok ? { data: { ok: true } } : { data: null, error: { code: opts.disconnectErrorCode ?? 'CHANNEL_DISCONNECT_FAILED' } }),
      } as Response;
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
    if (url.includes('/channel-connections/facebook/select') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'));
      const result = opts.onFacebookSelect?.(body) ?? {
        status: 201,
        body: { id: 'conn-fb-1', channel: 'facebook', account_id: body.page_id, account_label: '선택된 페이지', status: 'active', credential_kind: 'oauth' },
        nextConnections: [{ ...CONNECTION_ACTIVE, id: 'conn-fb-1', channel: 'facebook', account_id: body.page_id, account_label: '선택된 페이지' }],
      };
      const ok = result.status < 400;
      if (ok && result.nextConnections) connections = result.nextConnections;
      return { ok, status: result.status, json: async () => (ok ? { data: result.body } : { data: null, error: (result.body as { error?: unknown })?.error ?? result.body }) } as Response;
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
    // story #3504 — 해제·재인증은 owner 전용(_require_owner)이라 owner만 문구가 맞다
    // (옛 owner·admin 문구는 이 두 자리에선 거짓이었다).
    stubFetch({ connections: [{ ...CONNECTION_ACTIVE, status: 'expired' }] });
    await mount('member');
    const disconnectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '해제');
    expect(disconnectBtn).toBeUndefined();
    expect(container.textContent).toContain('이 작업은 owner만 할 수 있습니다');
  });

  it('story #3504 — admin도 해제·재인증 버튼이 안 보이고(owner 전용) owner만 문구를 본다', async () => {
    stubFetch({ connections: [{ ...CONNECTION_ACTIVE, status: 'expired' }] });
    await mount('admin');
    const disconnectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '해제');
    expect(disconnectBtn).toBeUndefined();
    const reauthBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '다시 연결');
    expect(reauthBtn).toBeUndefined();
    expect(container.textContent).toContain('이 작업은 owner만 할 수 있습니다');
  });

  it('story #3504 — 해제 실패(403 CHANNEL_CONNECTION_OWNER_ONLY)는 카드 안 문구로 표면화된다', async () => {
    stubFetch({ connections: [CONNECTION_ACTIVE], disconnectStatus: 403, disconnectErrorCode: 'CHANNEL_CONNECTION_OWNER_ONLY' });
    await mount('owner');
    const disconnectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '해제') as HTMLButtonElement;
    await act(async () => { disconnectBtn.click(); });
    await flush();
    expect(container.textContent).toContain('이 작업은 owner만 할 수 있습니다');
  });

  it('story #3504 — 해제 실패(그 외 오류)는 일반 실패 문구로 표면화된다', async () => {
    stubFetch({ connections: [CONNECTION_ACTIVE], disconnectStatus: 500 });
    await mount('owner');
    const disconnectBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '해제') as HTMLButtonElement;
    await act(async () => { disconnectBtn.click(); });
    await flush();
    expect(container.textContent).toContain('연결 해제에 실패했습니다');
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

// story #3436 묶음10(유나 §17-21⑧⑨, PO 確定 2026-09-06) — oauth 갈래 「{channel}
// 계정 연결」 버튼 낱말. 0개면 그대로·1개 이상이면 「계정 추가」로 갈린다(sandbox
// #3537과 달리 threads는 둘째 연결이 존재하지 않지만 이 축 자체는 oauth 갈래
// 공통 — wordpress/webhook 실재를 근거로 oauth에도 같은 원칙 적용). 0개일 때
// "추가"가 붙으면 거짓이므로 조건이 핵심 — 0/1/2 × owner/member 매트릭스로 pin.
describe('OrganizationChannelsPage — oauth 연결 버튼 낱말 매트릭스(story #3436 묶음10)', () => {
  function nConnections(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      ...CONNECTION_ACTIVE, id: `conn-${i}`, account_id: `acc-${i}`, account_label: `@acc${i}`,
    }));
  }

  it.each([
    { count: 0, expectedKey: 'channelConnectAction' as const },
    { count: 1, expectedKey: 'channelConnectAnotherAction' as const },
    { count: 2, expectedKey: 'channelConnectAnotherAction' as const },
  ])('owner·연결 $count개 — 버튼 낱말이 $expectedKey', async ({ count, expectedKey }) => {
    stubFetch({ connections: nConnections(count) });
    await mount('owner');
    // 행마다 "연결 시험"(channelTestAction) 버튼도 "연결" 부분문자열을 포함해
    // 느슨한 include 매칭은 잘못된 버튼을 집는다 — 기대 전체 문자열과 정확히
    // 일치하는 버튼을 직접 찾는다.
    const expectedText = koMessages.channelConnect[expectedKey].replace('{channel}', 'Threads');
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === expectedText);
    expect(btn).not.toBeUndefined();
    if (count === 0) expect(btn?.textContent).not.toContain('추가');
  });

  it.each([0, 1, 2])('member·연결 %i개 — 버튼 없이 전용 사유만(연결 수 무관, owner 전용 폭)', async (count) => {
    stubFetch({ connections: nConnections(count) });
    await mount('member');
    const connectBtn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === koMessages.channelConnect.channelConnectAction.replace('{channel}', 'Threads')
        || b.textContent === koMessages.channelConnect.channelConnectAnotherAction.replace('{channel}', 'Threads'),
    );
    expect(connectBtn).toBeUndefined();
    expect(container.textContent).toContain(
      koMessages.channelConnect.channelConnectOwnerOnlyReason.replace('{channel}', 'Threads'),
    );
  });
});

// story dd29e6dd(유나 5회차 관찰) — 헤더 rollup 칩이 연결 1개일 때 행 칩과 같은
// 문장을 두 번 보여주던 것. 처방=연결 0이면 자격 상태, 그 외(1/≥2)에만 중복 판단
// (연결 !== 1). 3표본(0/1/2개) 그대로 pin.
//
// ⚠️카디르군 REQUEST_CHANGES(2026-09-05, PR#3826) — 최초 버전은 「칩 총 개수 + 값」만
// 재서, "헤더 자리에 뜨고 행 자리엔 없는"(자리가 뒤바뀐) 회귀를 주입해도 그대로
// PASS했다(개수 1은 그대로 1이니까). data-testid로 헤더 컨테이너·행 컨테이너를
// 구조적으로 갈라 "그 자리 안에 몇 개가 있나"를 직접 잰다 — 값이 아니라 위치가 검증
// 대상이다.
//
// ⚠️PO 보정(2026-09-05, 유나 지적) — 최초 처방(`>= 2`)은 연결 0개일 때 헤더가 지는
// «자격 상태»(설정 미완·미연결)까지 지워 회귀를 냈다. 아래 "0개" 표본은 그래서
// 헤더 칩이 **없다**가 아니라 **자격 칩이 있다**를 pin한다(뒤집힌 것이 아니라 원래
// 잘못 pin됐던 것을 바로잡는 것).
describe('OrganizationChannelsPage — 헤더 rollup 칩 임계값(story dd29e6dd)', () => {
  it('⭐연결 0개 — 헤더 자리에 자격 상태 칩(설정 미완)이 그대로 남는다(rollup과는 다른 신호, 지우면 회귀)', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'none' } });
    await mount('owner');
    const header = container.querySelector('[data-testid="channel-section-header"]')!;
    const headerChips = header.querySelectorAll('[data-status-chip]');
    expect(headerChips).toHaveLength(1);
    expect(headerChips[0]?.getAttribute('data-status-chip')).toBe('config_incomplete');
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
    // story #3504 — 앱 자격 저장은 owner 전용(set_channel_app_credentials =
    // _require_owner)이라 owner만 문구가 맞다.
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' } });
    await mount('member');
    const registerBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '우리 조직 앱을 쓰려면 등록');
    expect(registerBtn).toBeUndefined();
    expect(container.textContent).toContain('이 작업은 owner만 할 수 있습니다');
  });

  it('story #3504 — admin도 앱 자격 등록 버튼이 없다(owner 전용, admin은 owner|admin이 아니다)', async () => {
    stubFetch({ connections: [], credentials: { configured: false, app_id_suffix: null, effective_source: 'platform' } });
    await mount('admin');
    const registerBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '우리 조직 앱을 쓰려면 등록');
    expect(registerBtn).toBeUndefined();
    expect(container.textContent).toContain('이 작업은 owner만 할 수 있습니다');
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

  it('member는 sandbox 버튼 대신 owner·admin 안내 문구를 본다', async () => {
    stubFetch({ connections: [], availableChannels: AVAILABLE_WITH_SANDBOX });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
    expect(container.textContent).toContain('이 작업은 owner·admin만 할 수 있습니다');
  });

  it('story #3504 — admin에게도 sandbox 「연결 만들기」 버튼이 보인다(owner|admin 폭)', async () => {
    stubFetch({ connections: [], availableChannels: AVAILABLE_WITH_SANDBOX });
    await mount('admin');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).not.toBeNull();
  });

  // story #3537(유나 18회차 발견, PO 確定 2026-09-06) — 배지는 연결 「행」의
  // credential_kind(상태)로, 버튼은 채널 「항목」의 credential_kind(성질)로만 그려
  // 연결이 이미 있어도 「…연결 만들기」가 활성으로 남았다. 채널에 연결이 하나라도
  // 있으면(상태 무관) 버튼 자체가 안 뜬다 — "다시 만들기" 경로는 의도적으로 없다.
  it('⭐#3537 — 이 채널에 연결이 이미 있으면(channel 일치) 「연결 만들기」 버튼이 안 뜬다', async () => {
    stubFetch({
      connections: [{ ...CONNECTION_ACTIVE, id: 'conn-sandbox-1', channel: 'sandbox', credential_kind: 'none' }],
      availableChannels: AVAILABLE_WITH_SANDBOX,
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
    // 배지는 여전히 뜬다(연결 자체가 사라진 게 아니다 — 버튼만 안 뜨는 것).
    expect(container.querySelector('[data-testid="channel-connect-sandbox-connection-badge"]')).not.toBeNull();
  });

  it('⭐#3537 — 연결 상태(만료 등)와 무관하게 그 채널에 행이 하나라도 있으면 버튼이 안 뜬다("다시 만들기" 경로 없음)', async () => {
    stubFetch({
      connections: [{ ...CONNECTION_ACTIVE, id: 'conn-sandbox-1', channel: 'sandbox', credential_kind: 'none', status: 'expired' }],
      availableChannels: AVAILABLE_WITH_SANDBOX,
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
  });

  it('⭐#3537 — 연결이 이미 있으면 member에게도 owner·admin 안내 문구가 안 뜬다(버튼과 조건 일치, 존재하지 않는 액션의 사유는 노이즈)', async () => {
    stubFetch({
      connections: [{ ...CONNECTION_ACTIVE, id: 'conn-sandbox-1', channel: 'sandbox', credential_kind: 'none' }],
      availableChannels: AVAILABLE_WITH_SANDBOX,
    });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).toBeNull();
    expect(container.textContent).not.toContain('이 작업은 owner·admin만 할 수 있습니다');
  });

  it('⭐#3537 — 다른 채널(threads)에만 연결이 있으면 sandbox 「연결 만들기」 버튼은 그대로 뜬다(channel 하드코딩 0, 일치로만 판정)', async () => {
    stubFetch({
      connections: [CONNECTION_ACTIVE], // channel: 'threads'
      availableChannels: AVAILABLE_WITH_SANDBOX,
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-sandbox-button"]')).not.toBeNull();
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

  // story #3523(PO 실측(3523 그라운딩·page.tsx:239)·確定 2026-09-06) — handleCreateSandbox가
  // 채널 문자열과 무관하게 항상 리터럴 `.../channel-connections/sandbox`로 고정돼 있어,
  // instagram_sandbox 카드의 「연결 만들기」를 눌러도 실은 Threads류 sandbox 연결을
  // 만드는 조용한 오분기였다. 이 테스트는 그 오분기 자체를 재현·고정한다 — 되돌리면
  // (item.channel 대신 다시 리터럴 'sandbox'로) RED.
  it('⭐instagram_sandbox 카드의 「연결 만들기」는 .../instagram_sandbox/sandbox로 가지 .../sandbox(리터럴)로 새지 않는다', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') calledUrls.push(url);
      if (url.includes('/channel-connections/available-channels')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            data: [
              { channel: 'sandbox', display_name: 'Sandbox', credential_kind: 'none', kind: 'social' },
              { channel: 'instagram_sandbox', display_name: 'Instagram Sandbox', credential_kind: 'none', kind: 'social' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/instagram_sandbox/sandbox') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ data: { id: 'ig-sb-1', channel: 'instagram_sandbox', account_id: 'instagram-sandbox-org-1', status: 'active' } }) } as Response;
      }
      if (url.includes('/app-credentials')) {
        return { ok: true, status: 200, json: async () => ({ data: { configured: false, app_id_suffix: null, effective_source: 'platform' } }) } as Response;
      }
      if (url.includes('/channel-connections')) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND' } }) } as Response;
    }));
    await mount('owner');

    const btns = [...container.querySelectorAll('[data-testid="channel-connect-sandbox-button"]')];
    expect(btns.length).toBe(2);
    // 두 번째 섹션(instagram_sandbox)의 버튼 — channelLabel로 문구가 갈린다(§13-6 어휘).
    const instagramSandboxBtn = btns.find((b) => b.textContent?.includes('Instagram 테스트용')) as HTMLButtonElement;
    expect(instagramSandboxBtn).not.toBeUndefined();

    await act(async () => { instagramSandboxBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();

    const sandboxPostCalls = calledUrls.filter((u) => u.includes('/channel-connections/') && (u.endsWith('/sandbox') || u.includes('/sandbox/')));
    expect(sandboxPostCalls).toEqual([expect.stringContaining('/instagram_sandbox/sandbox')]);
    expect(sandboxPostCalls.some((u) => u.endsWith('/channel-connections/sandbox'))).toBe(false);
    expect(container.querySelector('[data-testid="channel-connect-sandbox-error"]')).toBeNull();
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

  it('member는 버튼 대신 owner·admin 전용 사유만 본다(§5·AC4)', async () => {
    // story #3504 — 붙여넣기 연결 생성은 owner|admin 폭
    // (create_pasted_secret_channel_connection = _require_owner_or_admin)이라
    // owner·admin 문구가 맞다(owner 전용 문구는 이 자리에선 거짓이다).
    // story #3436 묶음10(유나 §17-21⑨) — 이 버튼 자리 전용 키로 분리.
    stubFetch({ connections: [], availableChannels: WORDPRESS_AVAILABLE });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).toBeNull();
    expect(container.textContent).toContain(
      koMessages.channelConnect.channelConnectOwnerOrAdminOnlyReason.replace('{channel}', 'WordPress'),
    );
  });

  it('story #3504 — admin은 붙여넣기 연결 카드를 실제로 본다(owner|admin 폭)', async () => {
    stubFetch({ connections: [], availableChannels: WORDPRESS_AVAILABLE });
    await mount('admin');
    expect(container.querySelector('[data-testid="channel-connect-pasted-secret-button-wordpress"]')).not.toBeNull();
  });

  it('⭐(AC5, story #3492로 secret_hint 부재 시로 범위 재확定) 응답에 secret_hint가 없으면 마스킹 흔적도 없다', async () => {
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
    // 어디에도 없다. secret_hint 필드 자체가 응답에 없으면(구버전 BFF·null) 이 화면이
    // 지어낼 값이 없다(story #3492 이전 AC5 원문 그대로, "필드 자체가 없던" 시절 대신
    // 지금은 "필드가 null·부재인" 케이스로 범위가 좁아졌을 뿐 — 있으면 다음 테스트처럼
    // 끝 4자리를 보여주는 게 정상 동작으로 바뀌었다).
    expect(container.textContent).toContain('admin');
    expect(container.textContent).not.toMatch(/•{2,}|\*{2,}/);
  });

  it('⭐story #3492 — secret_hint가 있으면 owner는 끝 4자리 힌트와 「자격 바꾸기」 버튼을 본다(원문은 절대 안 보인다)', async () => {
    stubFetch({
      connections: [{
        id: 'conn-wp-1', channel: 'wordpress', account_id: 'https://blog.example.com', account_label: 'admin',
        credential_kind: 'pasted_secret', status: 'active', token_expires_at: null, last_refreshed_at: null,
        last_error: null, can_auto_refresh: false, connected_by: 'member-1',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', secret_hint: '1234',
      }],
      availableChannels: WORDPRESS_AVAILABLE,
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-secret-hint-conn-wp-1"]')?.textContent).toBe('현재 자격 끝 4자리 1234');
    expect(container.querySelector('[data-testid="channel-connect-replace-credential-button-conn-wp-1"]')).not.toBeNull();
  });

  it('story #3492 — member는 힌트도 「자격 바꾸기」 버튼도 안 보이고 owner 전용 사유만 본다', async () => {
    stubFetch({
      connections: [{
        id: 'conn-wp-1', channel: 'wordpress', account_id: 'https://blog.example.com', account_label: 'admin',
        credential_kind: 'pasted_secret', status: 'active', token_expires_at: null, last_refreshed_at: null,
        last_error: null, can_auto_refresh: false, connected_by: 'member-1',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', secret_hint: '1234',
      }],
      availableChannels: WORDPRESS_AVAILABLE,
    });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-secret-hint-conn-wp-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-connect-replace-credential-button-conn-wp-1"]')).toBeNull();
  });

  it('story #3492 — owner가 「자격 바꾸기」 폼을 열고 제출하면 목록이 재조회되고 폼이 닫힌다', async () => {
    let patchCalled = false;
    let patchBody: unknown = null;
    const connectionWithHint = {
      id: 'conn-wp-1', channel: 'wordpress', account_id: 'https://blog.example.com', account_label: 'admin',
      credential_kind: 'pasted_secret', status: 'active', token_expires_at: null, last_refreshed_at: null,
      last_error: null, can_auto_refresh: false, connected_by: 'member-1',
      created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', secret_hint: '1234',
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/channel-connections/available-channels')) {
        return { ok: true, status: 200, json: async () => ({ data: WORDPRESS_AVAILABLE }) } as Response;
      }
      if (url.includes('/credentials') && init?.method === 'PATCH') {
        patchCalled = true;
        patchBody = init.body ? JSON.parse(init.body as string) : null;
        return { ok: true, status: 200, json: async () => ({ data: { ...connectionWithHint, secret_hint: '9999' } }) } as Response;
      }
      if (url.includes('/channel-connections')) {
        return { ok: true, status: 200, json: async () => ({ data: [connectionWithHint] }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ data: null, error: { code: 'NOT_FOUND' } }) } as Response;
    }));
    await mount('owner');

    const openBtn = container.querySelector('[data-testid="channel-connect-replace-credential-button-conn-wp-1"]') as HTMLButtonElement;
    await act(async () => { openBtn.click(); });
    await flush();

    // 유나 정본 §2④(페드루 PO 차단, PR#3841 리뷰) — 「이 자격이 어디서 오나」 필드-위
    // 도움말이 폼을 열면 보여야 한다(생성 폼과 같은 다섯 규격).
    expect(
      container.querySelector('[data-testid="channel-connect-replace-credential-hint-conn-wp-1"]')?.textContent,
    ).toContain('애플리케이션 비밀번호');

    const pwInput = container.querySelector('#conn-wp-1-app_password') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(pwInput, 'new-app-password-9999');
      pwInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const submitBtn = container.querySelector('[data-testid="channel-connect-replace-credential-submit-conn-wp-1"]') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    await flush();

    expect(patchCalled).toBe(true);
    expect((patchBody as { app_password?: string })?.app_password).toBe('new-app-password-9999');
    // 폼이 닫히고(재입력 필드가 사라지고) 목록 재조회로 새 힌트가 반영된다.
    expect(container.querySelector('[data-testid="channel-connect-replace-credential-form-conn-wp-1"]')).toBeNull();
  });
});

// story #3486(3436 묶음 8 잔여, 유나 10회차 관찰 2026-09-05) — 「연결 시각」이
// new Date(...).toLocaleString()(브라우저 로케일 의존)이던 것을 묶음 8 정본
// (formatRelativeTime)으로 정정. "지금"을 고정해(vi.setSystemTime) 결정적으로 잰다.
describe('OrganizationChannelsPage — 연결 시각 상대시각 정본(story #3486)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('⭐연결 3일 전 — 상대시각(브라우저 로케일 절대 포맷 아님)으로 보인다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
    stubFetch({ connections: [{ ...CONNECTION_ACTIVE, created_at: '2026-09-01T00:00:00Z' }] });
    await mount('owner');

    // 브라우저 로케일 절대 포맷(toLocaleString 특유의 "2026. 9. 1." 류 마침표 구분·
    // 오전/오후)이 하나도 안 남는다 — 이게 바로 이 스토리가 잡는 회귀 모양이다.
    expect(container.textContent).not.toMatch(/\d{4}\. \d{1,2}\. \d{1,2}\./);
    expect(container.textContent).not.toContain('오전');
    expect(container.textContent).not.toContain('오후');
    // 7일 이내라 formatRelativeTime의 상대 분기("전")로 떨어진다.
    expect(container.textContent).toContain('전');
  });

  it('연결 10일 전(7일 폴백 경계 밖) — formatRelativeTime의 절대 포맷(§11-2)으로 정상 폴백한다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T00:00:00Z'));
    stubFetch({ connections: [{ ...CONNECTION_ACTIVE, created_at: '2026-09-01T00:00:00Z' }] });
    await mount('owner');

    // 폴백도 formatScheduledAt(§11-2 정본)이지 브라우저 toLocaleString이 아니다 —
    // "MM-DD HH:mm TZ" 꼴(마침표 구분자 없음).
    expect(container.textContent).toMatch(/09-01 \d{2}:\d{2}/);
    expect(container.textContent).not.toMatch(/\d{4}\. \d{1,2}\. \d{1,2}\./);
  });
});

// story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 「성과 수집」 섹션.
// 발행 채널 카드와 별개 축(beacon·UTM). GA4 줄은 그리지 않는다(유나 §13-7 明示).
describe('OrganizationChannelsPage — 성과 수집(story #3540)', () => {
  it('BE 응답이 빈 배열이면 섹션 자체가 안 뜬다(기존 화면 회귀 0)', async () => {
    stubFetch({});
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-connections-section"]')).toBeNull();
  });

  it('조회 실패면 일반 오류 배너만 뜬다(섹션은 안 그림)', async () => {
    stubFetch({ measurementLoadFails: true });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-connections-section"]')).toBeNull();
    expect(container.textContent).toContain(koMessages.channelConnect.measurementLoadFailed);
  });

  it('beacon=not_started — 「아직 쓰지 않음」+「시작하기」, GA4 줄은 없다', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'beacon', status: 'not_started', last_seen_at: null, count_7d: null, settings_path: null },
        { key: 'utm', status: 'off', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-beacon-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementBeaconNotStarted);
    expect(container.textContent).toContain(koMessages.channelConnect.measurementBeaconStartAction);
    // 「연결됨」 낱말 금지(유나 §13-7 明示) · GA4 줄 자체가 없다(Phase 2 선행).
    expect(container.textContent).not.toContain('연결됨');
    expect(container.textContent).not.toContain('GA4');
  });

  it('⭐「시작하기」 클릭 → 키 인라인 패널(값+복사+스니펫) → 같은 마운트에서 상태가 no_data_yet으로 갱신된다(재로드 없이)', async () => {
    // 페드루 PO REQUIRED①(2026-09-06, #3896 리뷰) — 스니펫 베이스는 BE 주소
    // (NEXT_PUBLIC_FASTAPI_URL)여야 한다. FE 호스트(window.location.origin,
    // jsdom 기본 http://localhost:3000)가 섞이면 안 된다.
    vi.stubEnv('NEXT_PUBLIC_FASTAPI_URL', 'https://api.sprintable.example');
    let measurementCallCount = 0;
    stubFetch({
      measurementConnections: [
        { key: 'beacon', status: 'not_started', last_seen_at: null, count_7d: null, settings_path: null },
      ],
      onMeteringKey: () => ({ status: 200, body: { public_key: 'pk_live_abcdef123456' } }),
    });
    // stubFetch가 매 GET마다 같은 값을 주므로, 두 번째 measurement-connections 조회
    // 시점부터 no_data_yet을 돌려주도록 별도 스텁으로 다시 감싼다.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/measurement-connections')) {
        measurementCallCount += 1;
        const status = measurementCallCount === 1 ? 'not_started' : 'no_data_yet';
        return {
          ok: true, status: 200,
          json: async () => ({ data: [{ key: 'beacon', status, last_seen_at: null, count_7d: status === 'no_data_yet' ? 0 : null, settings_path: null }] }),
        } as Response;
      }
      return (originalFetch as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as typeof fetch;

    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-beacon-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementBeaconNotStarted);

    const startBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.channelConnect.measurementBeaconStartAction) as HTMLButtonElement;
    await act(async () => { startBtn.click(); });
    await flush();

    expect(container.querySelector('[data-testid="measurement-beacon-key-value"]')?.textContent).toBe('pk_live_abcdef123456');
    const snippetText = container.querySelector('[data-testid="measurement-beacon-snippet"]')?.textContent ?? '';
    expect(snippetText).toContain('pk_live_abcdef123456');
    expect(snippetText).toContain('/api/v2/public/pageview');
    // 페드루 PO REQUIRED①(2026-09-06, #3896 리뷰) — BE 베이스가 실려야 하고,
    // FE 호스트가 섞이면 안 된다(되돌리면 window.location.origin이 다시 붙어 RED).
    expect(snippetText).toContain('https://api.sprintable.example/api/v2/public/pageview');
    expect(snippetText).not.toContain(window.location.origin);
    expect(snippetText).toContain('utm_source');
    expect(snippetText).toContain('keepalive');
    // 재로드 없이 같은 마운트에서 상태 문구가 갱신됐다.
    expect(container.querySelector('[data-testid="measurement-beacon-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementBeaconNoDataYet);
  });

  it('beacon=has_data — 마지막 기록 상대시각·최근 7일 건수가 보인다', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    stubFetch({
      measurementConnections: [
        { key: 'beacon', status: 'has_data', last_seen_at: '2026-09-06T11:00:00Z', count_7d: 12, settings_path: null },
      ],
    });
    await mount('owner');
    const text = container.querySelector('[data-testid="measurement-beacon-status"]')?.textContent ?? '';
    expect(text).toContain('전');
    // 페드루 PO REQUIRED③(2026-09-06, #3896 리뷰) — count_7d가 문구에 실린다.
    expect(text).toContain('12');
  });

  it('beacon=has_data·count_7d=0 — 「0건」으로 뜬다(null이 아니다, null≠0 원칙)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
    stubFetch({
      measurementConnections: [
        { key: 'beacon', status: 'has_data', last_seen_at: '2026-08-31T11:00:00Z', count_7d: 0, settings_path: null },
      ],
    });
    await mount('owner');
    const text = container.querySelector('[data-testid="measurement-beacon-status"]')?.textContent ?? '';
    expect(text).toContain('0');
  });

  it('utm=auto — 자동 부착 문구·콘텐츠 규칙 링크', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'utm', status: 'auto', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-utm-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementUtmAuto);
    const link = container.querySelector('[data-testid="measurement-utm-settings-link"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/organization/content-rules');
  });

  it('utm=manual — 수동 규칙 문구', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'utm', status: 'manual', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-utm-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementUtmManual);
  });

  it('utm=off — 꺼짐 문구', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'utm', status: 'off', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-utm-status"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementUtmOff);
  });
});

// story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06 · 유나 §13-9) — GA4 「고객
// 소유」 연결. status 4종: disconnected·property_pending·connected·needs_reauth.
// 낱말 자리 일부(행 라벨·속성 placeholder류)는 유나 §절 확定 前 자리표시자.
describe('OrganizationChannelsPage — GA4 연결(story #3583)', () => {
  it('disconnected — 「미연결」+연결 버튼(GA4 계정 연결), 속성 선택 UI는 없다', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'disconnected', last_seen_at: null, count_7d: null, settings_path: null },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-ga4-status"]')?.textContent)
      .toBe(koMessages.channelConnect.channelStatusNotConnected);
    const btn = container.querySelector('[data-testid="measurement-ga4-authorize-button"]') as HTMLButtonElement;
    expect(btn.textContent).toBe(koMessages.channelConnect.channelConnectAction.replace('{channel}', 'GA4'));
    expect(container.querySelector('[data-testid="measurement-ga4-property-select"]')).toBeNull();
  });

  it('⭐disconnected — 연결 버튼 클릭 시 POST authorize 뒤 authorize_url로 전체 페이지 리다이렉트한다', async () => {
    const originalLocation = window.location;
    // jsdom의 location은 직접 대입이 안 막혀 있지 않으므로 href만 감시하는 대체 객체로 교체.
    Object.defineProperty(window, 'location', { value: { ...originalLocation, href: '' }, writable: true });
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'disconnected', last_seen_at: null, count_7d: null, settings_path: null },
      ],
      onGa4Authorize: () => ({ status: 200, body: { authorize_url: 'https://accounts.google.com/o/oauth2/mock-ga4' } }),
    });
    await mount('owner');
    const btn = container.querySelector('[data-testid="measurement-ga4-authorize-button"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    await flush();
    expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/mock-ga4');
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('needs_reauth — 「재인증 필요」+「다시 연결」 버튼(disconnected와 같은 authorize 경로)', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'needs_reauth', last_seen_at: null, count_7d: null, settings_path: null },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-ga4-status"]')?.textContent)
      .toBe(koMessages.channelConnect.channelStatusReauthRequired);
    expect((container.querySelector('[data-testid="measurement-ga4-authorize-button"]') as HTMLButtonElement).textContent)
      .toBe(koMessages.channelConnect.channelReauthAction);
  });

  it('⭐property_pending — 속성 목록을 자동으로 불러오고, 드롭다운+확인 버튼이 뜬다(연결 버튼은 없다)', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'property_pending', last_seen_at: null, count_7d: null, settings_path: null },
      ],
      ga4Properties: [{ property_id: 'p1', display_name: '뭉클랩 GA4' }, { property_id: 'p2', display_name: '테스트 속성' }],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-ga4-authorize-button"]')).toBeNull();
    const dropdown = container.querySelector('[data-testid="measurement-ga4-property-dropdown"]') as HTMLSelectElement;
    expect(dropdown).not.toBeNull();
    const optionLabels = Array.from(dropdown.options).map((o) => o.textContent);
    expect(optionLabels).toContain('뭉클랩 GA4');
    expect(optionLabels).toContain('테스트 속성');
    expect((container.querySelector('[data-testid="measurement-ga4-property-confirm"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('property_pending — 속성 목록 로드 실패면 실패 문구만(드롭다운 없음)', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'property_pending', last_seen_at: null, count_7d: null, settings_path: null },
      ],
      ga4PropertiesFails: true,
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-ga4-properties-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="measurement-ga4-property-dropdown"]')).toBeNull();
  });

  it('⭐property_pending — 속성 선택 후 확인 클릭 → select 호출 → 같은 마운트에서 connected로 갱신된다', async () => {
    let selectedBody: unknown = null;
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'property_pending', last_seen_at: null, count_7d: null, settings_path: null },
      ],
      ga4Properties: [{ property_id: 'p1', display_name: '뭉클랩 GA4' }],
      onGa4Select: (body) => {
        selectedBody = body;
        return {
          status: 200, body: { ok: true },
          nextMeasurementConnections: [
            { key: 'ga4', status: 'connected', last_seen_at: null, count_7d: null, settings_path: null, property_id: 'p1', property_name: '뭉클랩 GA4' },
          ],
        };
      },
    });
    await mount('owner');
    const dropdown = container.querySelector('[data-testid="measurement-ga4-property-dropdown"]') as HTMLSelectElement;
    await act(async () => { dropdown.value = 'p1'; dropdown.dispatchEvent(new Event('change', { bubbles: true })); });
    const confirmBtn = container.querySelector('[data-testid="measurement-ga4-property-confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(false);
    await act(async () => { confirmBtn.click(); });
    await flush();

    expect(selectedBody).toEqual({ property_id: 'p1' });
    expect(container.querySelector('[data-testid="measurement-ga4-status"]')?.textContent)
      .toBe(`${koMessages.channelConnect.channelStatusConnected} · 뭉클랩 GA4`);
  });

  it('⭐connected — 속성명이 상태 줄에 보이고, 「해제」 버튼 아래 상시 사유 문장이 있다(확인 대화상자 없음)', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'connected', last_seen_at: null, count_7d: null, settings_path: null, property_id: 'p1', property_name: '뭉클랩 GA4' },
      ],
    });
    await mount('owner');
    expect(container.querySelector('[data-testid="measurement-ga4-status"]')?.textContent)
      .toBe(`${koMessages.channelConnect.channelStatusConnected} · 뭉클랩 GA4`);
    expect((container.querySelector('[data-testid="measurement-ga4-disconnect-button"]') as HTMLButtonElement).textContent)
      .toBe(koMessages.channelConnect.channelDisconnectAction);
    expect(container.querySelector('[data-testid="measurement-ga4-disconnect-effect"]')?.textContent)
      .toBe(koMessages.channelConnect.measurementGa4DisconnectEffect);
  });

  it('⭐connected — 해제 클릭 → DELETE 호출(확인 대화상자 없이 즉시) → 같은 마운트에서 disconnected로 갱신된다', async () => {
    stubFetch({
      measurementConnections: [
        { key: 'ga4', status: 'connected', last_seen_at: null, count_7d: null, settings_path: null, property_id: 'p1', property_name: '뭉클랩 GA4' },
      ],
      onGa4Disconnect: () => ({
        status: 200,
        nextMeasurementConnections: [{ key: 'ga4', status: 'disconnected', last_seen_at: null, count_7d: null, settings_path: null }],
      }),
    });
    await mount('owner');
    const disconnectBtn = container.querySelector('[data-testid="measurement-ga4-disconnect-button"]') as HTMLButtonElement;
    await act(async () => { disconnectBtn.click(); });
    await flush();
    expect(container.querySelector('[data-testid="measurement-ga4-status"]')?.textContent)
      .toBe(koMessages.channelConnect.channelStatusNotConnected);
  });
});

// story #3549(3547 BE·디디 계약, 유나 §13-8, PO 確定 2026-09-06) — Facebook Page
// 연결 화면. 새로 짓는 것은 「선택 대기」 얼굴 하나뿐(§13-8 그라운딩) — 연결
// 시작 카드·연결 카드·실패 문구 배선은 기존 것을 그대로 쓴다.
describe('OrganizationChannelsPage — Facebook Page 연결(story #3549)', () => {
  const FACEBOOK_AVAILABLE = [
    { channel: 'facebook', display_name: 'Facebook', credential_kind: 'oauth', kind: 'social' },
  ];

  function selectPendingQuery(
    candidates: { page_id: string; name: string }[], extra: Record<string, string> = {}, channel = 'facebook',
  ) {
    return new URLSearchParams({
      select_pending: channel, pending_id: 'pending-1',
      candidates: JSON.stringify(candidates), ...extra,
    });
  }

  it('⭐§13-8① — owner에게 앱 안내 한 줄이 연결 버튼 위에 뜬다(연결 0개, 선택 대기 아님)', async () => {
    stubFetch({ connections: [], availableChannels: FACEBOOK_AVAILABLE });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-facebook-app-guidance"]')?.textContent)
      .toBe(koMessages.channelConnect.channelConnectFacebookAppGuidance);
  });

  it('member는 앱 안내를 안 본다(연결 버튼 자체가 없는 사람에게 준비물을 알려도 할 일이 없다)', async () => {
    stubFetch({ connections: [], availableChannels: FACEBOOK_AVAILABLE });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-facebook-app-guidance"]')).toBeNull();
  });

  it('⭐§13-8② — 후보 2개면 라디오 목록(이름+ID)이 뜨고 기본 선택이 없다, 앱 안내는 이제 안 뜬다', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([
      { page_id: 'p1', name: '우리 회사 페이지' }, { page_id: 'p2', name: '2호점' },
    ]));
    stubFetch({ connections: [], availableChannels: FACEBOOK_AVAILABLE });
    await mount('owner');
    const select = container.querySelector('[data-testid="channel-connect-facebook-select"]')!;
    expect(select.textContent).toContain('우리 회사 페이지');
    expect(select.textContent).toContain('p1');
    expect(select.textContent).toContain('2호점');
    const radios = select.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    expect(radios.length).toBe(2);
    expect([...radios].every((r) => !r.checked)).toBe(true);
    const submitBtn = container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="channel-connect-facebook-app-guidance"]')).toBeNull();
  });

  it('⭐§13-8② — 페이지를 고르면 버튼이 활성화되고, 「연결」을 누르면 select 호출 뒤 같은 자리가 연결 카드로 바뀐다(재로드 없이)', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([{ page_id: 'p1', name: '우리 회사 페이지' }]));
    let selectedBody: unknown = null;
    stubFetch({
      connections: [], availableChannels: FACEBOOK_AVAILABLE,
      onFacebookSelect: (body) => {
        selectedBody = body;
        return {
          status: 201,
          body: { id: 'conn-fb-1', channel: 'facebook', account_id: 'p1', account_label: '우리 회사 페이지', status: 'active', credential_kind: 'oauth' },
          nextConnections: [{ ...CONNECTION_ACTIVE, id: 'conn-fb-1', channel: 'facebook', account_id: 'p1', account_label: '우리 회사 페이지' }],
        };
      },
    });
    await mount('owner');
    const radio = container.querySelector('input[type="radio"][value="p1"]') as HTMLInputElement;
    await act(async () => { radio.click(); });
    const submitBtn = container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => { submitBtn.click(); });
    await flush();
    expect(selectedBody).toEqual({ pending_id: 'pending-1', page_id: 'p1' });
    expect(container.querySelector('[data-testid="channel-connect-facebook-select"]')).toBeNull();
    expect(container.textContent).toContain('우리 회사 페이지');
  });

  // 페드루 QA(2026-09-06) — FacebookPageSelectCard 자체의 owner 게이트가 호출부의
  // isOwnerStrict 조건과 중복이면 뮤테이션으로 안 걸리는 죽은 코드다(PastedSecretConnectCard
  // 선례 그대로 — owner 판정은 카드 안에서 진다, 호출부가 한 번 더 안 거른다). member도
  // 이 카드까지는 도달하되 카드 안에서 사유만 본다.
  it('member는 선택 대기 상태에서도 라디오 목록이 아니라 owner 전용 사유만 본다', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([{ page_id: 'p1', name: '우리 회사 페이지' }]));
    stubFetch({ connections: [], availableChannels: FACEBOOK_AVAILABLE });
    await mount('member');
    expect(container.querySelector('[data-testid="channel-connect-facebook-select"]')).toBeNull();
    expect(container.textContent).toContain(
      koMessages.channelConnect.channelConnectOwnerOnlyReason.replace('{channel}', 'Facebook'),
    );
  });

  it('⭐§13-8③ — 후보 0개는 두 원인을 하나로 뭉치지 않은 문구를 보인다(선택 UI 없음)', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([]));
    stubFetch({ connections: [], availableChannels: FACEBOOK_AVAILABLE });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-facebook-no-pages"]')?.textContent)
      .toBe(koMessages.channelConnect.channelConnectFacebookNoPages);
    expect(container.querySelector('[data-testid="channel-connect-facebook-select"]')).toBeNull();
  });

  it.each([
    ['CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND'],
    ['CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED'],
    ['CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN'],
  ] as const)('⭐§13-8④ — select 실패 %s는 「다시 연결」(기존 재인증 낱말 재사용)로 안내한다', async (code) => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([{ page_id: 'p1', name: 'X' }]));
    stubFetch({
      connections: [], availableChannels: FACEBOOK_AVAILABLE,
      onFacebookSelect: () => ({ status: 404, body: { error: { code } } }),
    });
    await mount('owner');
    const radio = container.querySelector('input[type="radio"][value="p1"]') as HTMLInputElement;
    await act(async () => { radio.click(); });
    await act(async () => { (container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement).click(); });
    await flush();
    const errorBlock = container.querySelector('[data-testid="channel-connect-facebook-select-error"]')!;
    expect(errorBlock.textContent).toContain(koMessages.channelConnect.channelConnectFacebookSelectGone);
    const reauthLink = errorBlock.querySelector('a');
    expect(reauthLink?.textContent).toBe(koMessages.channelConnect.channelReauthAction);
    expect(reauthLink?.getAttribute('href')).toBe('/api/oauth-channel/authorize?org=org-1&channel=facebook');
  });

  // 페드루 PO REQUIRED 2(#3905 리뷰, 유나 §13-8④-b 채택, 2026-09-06) — 503과
  // INVALID_PAGE는 원인이 다르니 서버 message를 더는 그대로 보여주지 않고 고정
  // 두 문장으로 가른다. 503은 같은 페이지 재시도가 뜻이 있어 「다시 시도」 유지 —
  // 이 화면엔 자동 재시도가 없어 §22-15의 "다시 시도" 금지 사유가 안 걸린다.
  it('⭐§13-8④-b — select 실패 PROVIDER_UNAVAILABLE(503)은 고정 문장+「다시 시도」로 같은 페이지를 재전송한다', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([{ page_id: 'p1', name: 'X' }]));
    let attempts = 0;
    let lastBody: unknown = null;
    stubFetch({
      connections: [], availableChannels: FACEBOOK_AVAILABLE,
      onFacebookSelect: (body) => {
        attempts += 1;
        lastBody = body;
        return { status: 503, body: { error: { code: 'CHANNEL_OAUTH_PROVIDER_UNAVAILABLE', message: '서버 메시지(이제 안 씀)' } } };
      },
    });
    await mount('owner');
    const radio = container.querySelector('input[type="radio"][value="p1"]') as HTMLInputElement;
    await act(async () => { radio.click(); });
    await act(async () => { (container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement).click(); });
    await flush();
    const errorBlock = container.querySelector('[data-testid="channel-connect-facebook-select-error"]')!;
    expect(errorBlock.textContent).toContain(koMessages.channelConnect.channelConnectFacebookSelectProviderUnavailable);
    expect(errorBlock.querySelector('a')).toBeNull();
    const retryBtn = errorBlock.querySelector('button') as HTMLButtonElement;
    expect(retryBtn.textContent).toBe(koMessages.channelConnect.channelConnectFacebookSelectRetryCta);
    await act(async () => { retryBtn.click(); });
    await flush();
    expect(attempts).toBe(2);
    expect(lastBody).toEqual({ pending_id: 'pending-1', page_id: 'p1' });
  });

  it('⭐§13-8④-b — select 실패 INVALID_PAGE는 고정 문장을 보이며 라디오 목록으로 돌아가고 선택이 해제된다(같은 실패로 가는 버튼 금지, 재시도 CTA 없음)', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery([
      { page_id: 'p1', name: 'X' }, { page_id: 'p2', name: 'Y' },
    ]));
    stubFetch({
      connections: [], availableChannels: FACEBOOK_AVAILABLE,
      onFacebookSelect: () => ({ status: 400, body: { error: { code: 'CHANNEL_OAUTH_PENDING_SELECTION_INVALID_PAGE' } } }),
    });
    await mount('owner');
    const radioP1 = container.querySelector('input[type="radio"][value="p1"]') as HTMLInputElement;
    await act(async () => { radioP1.click(); });
    await act(async () => { (container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement).click(); });
    await flush();

    // 별도 에러 화면이 아니라 라디오 목록 그대로 — 재시도 버튼도 없다.
    expect(container.querySelector('[data-testid="channel-connect-facebook-select-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="channel-connect-facebook-select-invalid-page"]')?.textContent)
      .toBe(koMessages.channelConnect.channelConnectFacebookSelectInvalidPage);
    const radios = container.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    expect([...radios].every((r) => !r.checked)).toBe(true);
    const submitBtn = container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // 다른 페이지를 고르면 문구가 사라지고 다시 제출할 수 있다.
    const radioP2 = container.querySelector('input[type="radio"][value="p2"]') as HTMLInputElement;
    await act(async () => { radioP2.click(); });
    expect(container.querySelector('[data-testid="channel-connect-facebook-select-invalid-page"]')).toBeNull();
    expect(submitBtn.disabled).toBe(false);
  });

  // 페드루 PO REQUIRED 1(#3905 리뷰, 2026-09-06) — 실 Meta App Review 前엔
  // facebook_sandbox가 §13-8 라이브 검증(AC5)의 유일한 길이다. 카드·앱 안내·
  // select BFF 전부 channel 문자열이 아니라 kind 판별자만 보게 채널 무관이어야
  // 한다(디디 PR#3904 실측: select는 pending.channel로 어댑터를 뽑지 URL로 안
  // 가른다 — channel_connections.py:661/663/687, facebook_sandbox pending도
  // 같은 리터럴 /facebook/select로 통과).
  const FACEBOOK_SANDBOX_AVAILABLE = [
    { channel: 'facebook_sandbox', display_name: 'Facebook Page Sandbox', credential_kind: 'oauth', kind: 'social' },
  ];

  it('facebook_sandbox — 앱 안내·선택 대기 얼굴이 facebook과 동형으로 뜬다(채널 문자열이 아니라 kind만 본다)', async () => {
    stubFetch({ connections: [], availableChannels: FACEBOOK_SANDBOX_AVAILABLE });
    await mount('owner');
    expect(container.querySelector('[data-testid="channel-connect-facebook-app-guidance"]')?.textContent)
      .toBe(koMessages.channelConnect.channelConnectFacebookAppGuidance);
  });

  it('facebook_sandbox — select_pending=facebook_sandbox면 그 채널 카드에서만 라디오 목록이 뜬다', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery(
      [{ page_id: 'sandbox-page-1', name: 'Sandbox Page 1' }], {}, 'facebook_sandbox',
    ));
    stubFetch({ connections: [], availableChannels: FACEBOOK_SANDBOX_AVAILABLE });
    await mount('owner');
    const select = container.querySelector('[data-testid="channel-connect-facebook-select"]')!;
    expect(select.textContent).toContain('Sandbox Page 1');
  });

  it('facebook_sandbox — 선택 성공 시 select 호출이 (stubFetch의 literal /facebook/select 라우팅에) 맞아 카드가 연결 행으로 바뀐다(디디 PR#3904 실측 — pending.channel로 어댑터를 뽑지 URL 세그먼트로 안 가른다)', async () => {
    useSearchParamsMock.mockReturnValue(selectPendingQuery(
      [{ page_id: 'sandbox-page-1', name: 'Sandbox Page 1' }], {}, 'facebook_sandbox',
    ));
    let selectCalled = false;
    stubFetch({
      connections: [], availableChannels: FACEBOOK_SANDBOX_AVAILABLE,
      onFacebookSelect: (body) => {
        selectCalled = true;
        return {
          status: 201,
          body: { id: 'conn-fbs-1', channel: 'facebook_sandbox', account_id: (body as { page_id: string }).page_id, account_label: 'Sandbox Page 1', status: 'active', credential_kind: 'oauth' },
          nextConnections: [{ ...CONNECTION_ACTIVE, id: 'conn-fbs-1', channel: 'facebook_sandbox', account_id: 'sandbox-page-1', account_label: 'Sandbox Page 1' }],
        };
      },
    });
    await mount('owner');
    const radio = container.querySelector('input[type="radio"][value="sandbox-page-1"]') as HTMLInputElement;
    await act(async () => { radio.click(); });
    await act(async () => { (container.querySelector('[data-testid="channel-connect-facebook-select-submit"]') as HTMLButtonElement).click(); });
    await flush();
    // stubFetch는 url.includes('/channel-connections/facebook/select')일 때만
    // onFacebookSelect를 태운다 — 이게 true라는 사실 자체가 카드의 실제 호출이
    // 리터럴 facebook 세그먼트를 쓴다는 증거다(channel prop='facebook_sandbox'인데도).
    expect(selectCalled).toBe(true);
    expect(container.querySelector('[data-testid="channel-connect-facebook-select"]')).toBeNull();
    expect(container.textContent).toContain('Sandbox Page 1');
  });
});
