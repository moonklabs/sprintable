// @vitest-environment jsdom
//
// story #3982 §(e) 콘텐츠 규칙 — 3상태와 「사라짐 0」(한도 2행은 항상 둘 다 렌더 — 하나가
// null이어도 그 행 자체가 없어지지 않는다·참고 항목은 접힘 상태에서도 펼치면 값이 나온다).
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
  const { ConnectRulesV3Rules } = await import('./connect-rules-v3-rules');
  await act(async () => { root.render(wrap(<ConnectRulesV3Rules orgId="org1" />)); });
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

const BASE_RULES = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
};

describe('ConnectRulesV3Rules', () => {
  it('오류 — 「다시 시도」 버튼이 보인다', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
  });

  it('⭐한도 2행 — 하나만 설정돼도 두 행 모두 렌더(사라짐 0)', async () => {
    routeFetch({
      '/api/organizations/org1/content-rules': { data: { rules: BASE_RULES } },
      '/api/organizations/org1/generation-budget': { data: { limit_minor: 100000, currency: 'KRW', period: 'month' } },
      '/api/organizations/org1/api-usage-budget': { data: { limit_minor: null, currency: null, period: 'month' } },
    });
    await mount();
    expect(container.textContent).toContain('생성 비용 한도');
    expect(container.textContent).toContain('X 비용 한도');
    expect(container.textContent).toContain('100,000원');
    expect(container.textContent).toContain('없음');
  });

  it('금칙어·UTM 필수 행 — 0건/꺼짐이어도 행 자체는 남는다', async () => {
    routeFetch({
      '/api/organizations/org1/content-rules': { data: { rules: BASE_RULES } },
      '/api/organizations/org1/generation-budget': { data: { limit_minor: null, currency: null, period: 'month' } },
      '/api/organizations/org1/api-usage-budget': { data: { limit_minor: null, currency: null, period: 'month' } },
    });
    await mount();
    expect(container.textContent).toContain('금칙어');
    expect(container.textContent).toContain('UTM 필수');
    expect(container.textContent).toContain('꺼짐');
  });

  it('⭐참고 항목 접힘 — 펼치면 톤·택소노미·채널 우선순위·브랜드 킷 값이 나온다', async () => {
    routeFetch({
      '/api/organizations/org1/content-rules': {
        data: {
          rules: {
            ...BASE_RULES,
            tone: '친근하고 간결하게',
            taxonomy: ['블로그', '뉴스레터'],
            channel_priority: ['threads', 'instagram'],
            brand_kit: { colors: ['#111111'] },
          },
        },
      },
      '/api/organizations/org1/generation-budget': { data: { limit_minor: null, currency: null, period: 'month' } },
      '/api/organizations/org1/api-usage-budget': { data: { limit_minor: null, currency: null, period: 'month' } },
    });
    await mount();
    const toggle = container.querySelector('[data-testid="connect-rules-v3-reference-toggle"]') as HTMLButtonElement;
    expect(container.querySelector('[data-testid="connect-rules-v3-reference-body"]')).toBeNull();
    await act(async () => { toggle.click(); });
    const body = container.querySelector('[data-testid="connect-rules-v3-reference-body"]');
    expect(body?.textContent).toContain('친근하고 간결하게');
    expect(body?.textContent).toContain('블로그, 뉴스레터');
    expect(body?.textContent).toContain('threads, instagram');
  });
});
