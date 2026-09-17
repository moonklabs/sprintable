// @vitest-environment jsdom
//
// story #3982 §(d) 연결된 채널 — 3상태와 「사라짐 0」(다시 연결 필요 행도 남아 배너+
// 버튼을 낸다·ads kind는 목록에서 제외·성과 수집 항목은 그대로 노출).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

const fetchMock = vi.fn();

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
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { ConnectRulesV3Channels } = await import('./connect-rules-v3-channels');
  await act(async () => { root.render(wrap(<ConnectRulesV3Channels orgId="org1" />)); });
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

  it('⭐ads kind는 목록에서 제외되고, blog/social kind만 남는다', async () => {
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
    expect(container.textContent).not.toContain('Meta 광고');
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

  it('⭐성과 수집 절 — measurement 항목이 있으면 항상 노출된다(사라짐 0)', async () => {
    routeFetch({
      '/api/organizations/org1/channel-connections/available-channels': { data: [] },
      '/api/organizations/org1/channel-connections': { data: [] },
      '/api/organizations/org1/measurement-connections': {
        data: [{ key: 'ga4', status: 'connected', last_seen_at: null, count_7d: null }],
      },
    });
    await mount();
    expect(container.textContent).toContain('성과 수집');
    expect(container.textContent).toContain('GA4 유입');
  });
});
