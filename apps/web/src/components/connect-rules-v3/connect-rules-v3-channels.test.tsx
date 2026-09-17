// @vitest-environment jsdom
//
// story #3982 §(d) 연결된 채널 — 3상태와 「사라짐 0」(다시 연결 필요 행도 남아 배너+
// 버튼을 낸다·ads kind도 「광고 계정」 소묶음으로 남는다·성과 수집 절은 목록 0이어도
// 항상 렌더). PO CHANGES-1(2026-09-17) — ads 제외는 사라짐 0 위반이라 철회.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();

// story #4019 — OAuthResultBanner(channel-connect/oauth-result-banner.tsx)가 이제
// 이 화면 맨 위에서 useSearchParams·usePathname·useRouter를 쓴다(결과 인자 정리,
// legacy channels/page.test.tsx와 동형 mock 관례).
const { useSearchParamsMock, routerReplaceMock } = vi.hoisted(() => ({
  useSearchParamsMock: vi.fn(),
  routerReplaceMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => useSearchParamsMock(),
  usePathname: () => '/connect-rules',
  useRouter: () => ({ replace: routerReplaceMock }),
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  routerReplaceMock.mockClear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(isOwnerStrict = true) {
  const { ConnectRulesV3Channels } = await import('./connect-rules-v3-channels');
  await act(async () => { root.render(wrap(<ConnectRulesV3Channels orgId="org1" isOwnerStrict={isOwnerStrict} />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

function routeFetch(map: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    for (const [prefix, payload] of Object.entries(map)) {
      if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('ConnectRulesV3Channels', () => {
  it('⭐빈 상태 — 등록된 채널이 없으면 빈 문구', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': { data: [] },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('아직 연결된 채널이 없어요');
  });

  it('오류 — 「다시 시도」 버튼이 보인다', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
  });

  it('⭐ads kind — 사라지지 않고 「광고 계정」 소묶음 아래 남는다(사라짐 0)', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': {
        data: [
          { channel: 'hosted_site', display_name: '호스팅 블로그', credential_kind: 'none', kind: 'blog' },
          { channel: 'meta_ads', display_name: 'Meta 광고', credential_kind: 'oauth', kind: 'ads' },
        ],
      },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('호스팅 블로그');
    expect(container.textContent).toContain('광고 계정');
    expect(container.textContent).toContain('Meta 광고');
  });

  it('⭐다시 연결 필요(만료) 행 — 사라지지 않고 배너+「다시 연결」 버튼을 낸다', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': {
        data: [{ channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' }],
      },
      '/api/organizations/org1/channel-connections': {
        data: [{ id: 'c1', channel: 'threads', account_id: 'acc1', credential_kind: 'oauth', status: 'expired', token_expires_at: null }],
      },
      '/api/organizations/org1/measurement-connections': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('다시 연결 필요');
    expect(container.textContent).toContain('연결이 만료됐어요');
    expect(container.textContent).toContain('다시 연결');
  });

  it('연결됨 행 — 중립 배지, 재연결 배너 없음', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': {
        data: [{ channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' }],
      },
      '/api/organizations/org1/channel-connections': {
        data: [{ id: 'c1', channel: 'threads', account_id: 'acc1', credential_kind: 'oauth', status: 'active', token_expires_at: null }],
      },
      '/api/organizations/org1/measurement-connections': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('연결됨');
    expect(container.textContent).not.toContain('연결이 만료됐어요');
  });

  it('⭐성과 수집 절 — 목록이 0건이어도 절 제목 자체는 항상 렌더(사라짐 0)', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': { data: [] },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': { data: [] },
    });
    await mount();
    expect(container.textContent).toContain('성과 수집');
  });

  it('성과 수집 — GA4 연결됨은 속성 이름과 함께, 3값 문장은 기존 키를 그대로 재사용', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': { data: [] },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': {
        data: [
          { key: 'ga4', status: 'connected', property_name: 'GA4 속성', last_seen_at: null, count_7d: null, settings_path: null },
          { key: 'utm', status: 'auto', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
          { key: 'beacon', status: 'no_data_yet', last_seen_at: null, count_7d: null, settings_path: null },
        ],
      },
    });
    await mount();
    expect(container.textContent).toContain('GA4 유입');
    expect(container.textContent).toContain('연결됨 · GA4 속성');
    expect(container.textContent).toContain('조직 규칙 값으로 붙어요');
    expect(container.textContent).toContain('콘텐츠 규칙에서 바꾸기');
    expect(container.textContent).toContain('아직 들어온 기록이 없어요');
  });

  it('⭐성과 수집 — GA4 미연결은 주의 색+「GA4 계정 연결」 링크(사람 손 필요만 색)', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': { data: [] },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': {
        data: [{ key: 'ga4', status: 'disconnected', last_seen_at: null, count_7d: null, settings_path: null }],
      },
    });
    await mount();
    expect(container.textContent).toContain('미연결');
    expect(container.textContent).toContain('GA4 계정 연결');
  });

  it('성과 수집 절 fetch 실패 — 절 전체 공용 오류+재시도로 떨어진다(조용히 사라짐 0)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/organizations/org1/measurement-connections')) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
    expect(container.querySelector('button')?.textContent).toContain('다시 시도');
  });

  // story #4019(PO 確定 2026-09-17) — OAuthResultBanner를 목록 맨 위에 마운트. 레거시
  // organization/channels/page.test.tsx와 같은 문구 키로 뜨는지(바이트 동일 보장의
  // 실측), AC2(결과 인자 정리)도 이 화면에서 똑같이 동작하는지.
  describe('OAuth 결과 배너(story #4019, 레거시와 공유 컴포넌트)', () => {
    it('⭐?connected= 쿼리로 성공 배너가 채널 목록 위에 뜬다(레거시와 같은 문구)', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connected=threads'));
      routeFetch({
        '/api/organizations/org1/channel-connections/available-channels': { data: [] },
        '/api/organizations/org1/channel-connections': { data: [] },
        '/api/organizations/org1/measurement-connections': { data: [] },
      });
      await mount();
      expect(container.textContent).toContain('Threads 연결이 완료됐어요');
    });

    it('⭐?connect_error=로 알려진 코드는 사람 말로 뜬다(레거시와 같은 문구 키)', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=CHANNEL_APP_CREDENTIALS_MISSING'));
      routeFetch({
        '/api/organizations/org1/channel-connections/available-channels': { data: [] },
        '/api/organizations/org1/channel-connections': { data: [] },
        '/api/organizations/org1/measurement-connections': { data: [] },
      });
      await mount(true);
      expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissing);
    });

    it('isOwnerStrict=false면 member용 문구가 뜬다(owner용 문구 없음)', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=CHANNEL_APP_CREDENTIALS_MISSING'));
      routeFetch({
        '/api/organizations/org1/channel-connections/available-channels': { data: [] },
        '/api/organizations/org1/channel-connections': { data: [] },
        '/api/organizations/org1/measurement-connections': { data: [] },
      });
      await mount(false);
      expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissingMember);
      expect(container.textContent).not.toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissing);
    });

    it('⭐표시 뒤 router.replace로 결과 인자를 지운다(AC2, scroll:false — 레거시와 동형)', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connected=threads'));
      routeFetch({
        '/api/organizations/org1/channel-connections/available-channels': { data: [] },
        '/api/organizations/org1/channel-connections': { data: [] },
        '/api/organizations/org1/measurement-connections': { data: [] },
      });
      await mount();
      expect(routerReplaceMock).toHaveBeenCalledWith('/connect-rules', { scroll: false });
    });

    it('결과 인자가 없으면 배너도 router.replace 호출도 없다', async () => {
      routeFetch({
        '/api/organizations/org1/channel-connections/available-channels': { data: [] },
        '/api/organizations/org1/channel-connections': { data: [] },
        '/api/organizations/org1/measurement-connections': { data: [] },
      });
      await mount();
      expect(routerReplaceMock).not.toHaveBeenCalled();
    });

    // PO CHANGES-2(2026-09-17 16:26Z) — 배너가 loadState('loading'|'error') 분기
    // 안쪽에 있으면 목록 로딩/실패 중엔 배너 자체가 안 떠서, ?connect_error=로 돌아온
    // 사람이 실패 이유를 못 봄(레거시엔 loadState 개념이 없어 이 문제가 없었음). 배너를
    // 3상태 공통 래퍼로 옮긴 회귀 방지.
    it('⭐목록 fetch가 아직 안 끝났어도(로딩 중) ?connected= 배너는 뜬다', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connected=threads'));
      fetchMock.mockImplementation(() => new Promise(() => {}));
      await mount();
      expect(container.textContent).toContain('Threads 연결이 완료됐어요');
    });

    it('⭐목록 fetch가 실패해도 ?connect_error= 배너와 구획 오류가 둘 다 뜬다', async () => {
      useSearchParamsMock.mockReturnValue(new URLSearchParams('connect_error=CHANNEL_APP_CREDENTIALS_MISSING'));
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      await mount(true);
      expect(container.textContent).toContain(koMessages.channelConnect.channelConnectErrorAppCredentialsMissing);
      expect(container.textContent).toContain('불러오지 못했어요');
    });
  });
});
