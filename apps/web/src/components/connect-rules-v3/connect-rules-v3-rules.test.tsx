// @vitest-environment jsdom
//
// story #3982 §(e) 콘텐츠 규칙 — 3상태와 「사라짐 0」(한도 2행은 항상 둘 다 렌더 — 하나가
// null이어도 그 행 자체가 없어지지 않는다·UTM 자동 부착 행 별도·참고 항목은 접힘 상태에서도
// 펼치면 값이 나온다). PO CHANGES-3(2026-09-17) — generation_budget/api_usage_budget/
// utm_rules는 전부 content-rules 응답 하나에 nested(별도 GET 2개 안 부름, 콜 예산 절약).
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

function stubContentRules(rules: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/organizations/org1/content-rules')) {
      return { ok: true, status: 200, json: async () => ({ data: { rules } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

const BASE_RULES = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
  generation_budget: null, api_usage_budget: null, utm_rules: null,
};

describe('ConnectRulesV3Rules', () => {
  it('오류 — 「다시 시도」 버튼이 보인다', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await mount();
    expect(container.textContent).toContain('불러오지 못했어요');
  });

  it('⭐한도 2행 — content-rules 응답 하나에 nested된 값만으로 하나만 설정돼도 두 행 모두 렌더(사라짐 0, 별도 GET 0)', async () => {
    stubContentRules({
      ...BASE_RULES,
      generation_budget: { limit_minor: 100000, currency: 'KRW', period: 'month' },
      api_usage_budget: null,
    });
    await mount();
    expect(container.textContent).toContain('생성 비용 한도');
    expect(container.textContent).toContain('X 비용 한도');
    expect(container.textContent).toContain('100,000원');
    expect(container.textContent).toContain('없음');
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/generation-budget'))).toBe(false);
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes('/api-usage-budget'))).toBe(false);
  });

  it('금칙어·UTM 필수·UTM 자동 부착 행 — 전부 꺼짐이어도 세 행 다 남는다(중립=muted, Badge 아님)', async () => {
    stubContentRules(BASE_RULES);
    await mount();
    expect(container.textContent).toContain('금칙어');
    expect(container.textContent).toContain('UTM 필수');
    expect(container.textContent).toContain('UTM 자동 부착');
    expect(container.querySelectorAll('[data-testid="connect-rules-v3-utm-auto-row"] [data-slot="badge"]').length).toBe(0);
  });

  it('⭐UTM 자동 부착 행 — enabled=true면 켜짐으로 렌더', async () => {
    stubContentRules({ ...BASE_RULES, utm_rules: { enabled: true } });
    await mount();
    const row = container.querySelector('[data-testid="connect-rules-v3-utm-auto-row"]');
    expect(row?.textContent).toContain('켜짐');
  });

  it('금칙어 — 항목이 있으면 켜짐(개수 배지 아님)', async () => {
    stubContentRules({ ...BASE_RULES, banned_terms: ['spam', 'scam'] });
    await mount();
    expect(container.textContent).not.toContain('2건');
    const bannedRow = Array.from(container.querySelectorAll('div')).find((d) => d.textContent?.includes('금칙어') && d.textContent.includes('켜짐'));
    expect(bannedRow).toBeTruthy();
  });

  it('⭐참고 항목 접힘 — 펼치면 톤·택소노미·채널 우선순위·브랜드 킷 값이 나온다', async () => {
    stubContentRules({
      ...BASE_RULES,
      tone: '친근하고 간결하게',
      taxonomy: ['블로그', '뉴스레터'],
      channel_priority: ['threads', 'instagram'],
      brand_kit: { colors: ['#111111'] },
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

  // story #3982 CHANGES(3998 통합 리허설 디디 결함① — 페드루 PO 지시 2026-09-17) —
  // 콘텐츠 규칙을 한 번도 저장 안 한 org의 실 BE 응답 모양(`rules: {}`, content_rules.py:123
  // 미설정 분기)을 이 픽스처가 한 번도 안 쟀다(BASE_RULES가 늘 필드를 다 채워 둠). `{}`는
  // truthy라 `!rules` 분기를 못 잡아 `rules.banned_terms.length` 등에서 화면 전체 크래시.
  it('⭐실 BE 미설정 모양 — rules:{}(완전 빈 객체)여도 크래시 없이 전부 «없음/꺼짐»으로 렌더', async () => {
    stubContentRules({});
    await mount();
    expect(container.textContent).toContain('금칙어');
    expect(container.textContent).toContain('UTM 필수');
    expect(container.textContent).toContain('UTM 자동 부착');
    expect(container.textContent).toContain('생성 비용 한도');
    expect(container.textContent).toContain('X 비용 한도');
    const toggle = container.querySelector('[data-testid="connect-rules-v3-reference-toggle"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    const body = container.querySelector('[data-testid="connect-rules-v3-reference-body"]');
    expect(body?.textContent).toContain('안 정함');
  });

  it('⭐필드 일부 누락(taxonomy·channel_priority 없음) — 크래시 없이 그 두 필드만 「안 정함」', async () => {
    stubContentRules({ banned_terms: ['spam'], require_utm: true, tone: '친근하게' });
    await mount();
    expect(container.textContent).toContain('금칙어');
    const toggle = container.querySelector('[data-testid="connect-rules-v3-reference-toggle"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    const body = container.querySelector('[data-testid="connect-rules-v3-reference-body"]');
    expect(body?.textContent).toContain('친근하게');
    expect(body?.textContent?.match(/안 정함/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
