// @vitest-environment jsdom
//
// story #3979(AC1) — 첫 화면 요약 4칸(나간 글·자연 조회·쓴 광고비·남은 한도),
// 각 칸 실측/미측정 2갈래(4칸×2). 없는 수를 0으로 안 그린다 — §⑤ 규율 그대로.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ResultsSummaryCards } from './results-summary-cards';
import type { PublishedInWindow, ViewsInWindow } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function stubCostSummary(ads: {
  approved_boost_count: number; sealed_ads_currency: string | null;
  captured_spend_minor: number | null; remaining_minor: number | null;
}) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: { ads } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
}

const MEASURED_ADS = {
  approved_boost_count: 2, sealed_ads_currency: 'KRW',
  captured_spend_minor: 12_345, remaining_minor: 137_655,
};
const NO_APPROVED_BOOSTS = {
  approved_boost_count: 0, sealed_ads_currency: null,
  captured_spend_minor: 0, remaining_minor: 0,
};

const MEASURED_VIEWS: ViewsInWindow = { sum: 4200, captured_rows: 5, total_rows: 5 };
const PARTIAL_VIEWS: ViewsInWindow = { sum: 900, captured_rows: 2, total_rows: 5 };
const MEASURED_PUBLISHED: PublishedInWindow = { count: 7, by_channel: [{ channel_kind: 'threads', count: 7 }], since: '2026-09-10T00:00:00Z' };

async function mount(props: Partial<Parameters<typeof ResultsSummaryCards>[0]> = {}) {
  await act(async () => {
    root.render(wrap(
      <ResultsSummaryCards
        orgId="org-1"
        publishedInWindow={props.publishedInWindow ?? null}
        viewsInWindow={props.viewsInWindow ?? null}
        ga4ConnectionStatus={props.ga4ConnectionStatus ?? 'not_connected'}
      />,
    ));
  });
  await flush();
}

describe('ResultsSummaryCards(story #3979 AC1) — 나간 글', () => {
  it('⭐published_in_window 있으면 실값', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ publishedInWindow: MEASURED_PUBLISHED });
    expect(container.querySelector('[data-testid="results-summary-published-value"]')?.textContent).toBe('7');
  });

  it('⭐published_in_window 없으면(3978 미착지 포함) 「미측정」, 0을 안 그린다', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ publishedInWindow: null });
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-published-value"]')).toBeNull();
  });
});

describe('ResultsSummaryCards(story #3979 AC1) — 자연 조회', () => {
  it('⭐views_in_window 있으면 실값(전량 captured면 부분측정 안내 없음)', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ viewsInWindow: MEASURED_VIEWS });
    expect(container.querySelector('[data-testid="results-summary-organic-views-value"]')?.textContent).toBe('4,200');
    expect(container.querySelector('[data-testid="results-summary-organic-views-partial"]')).toBeNull();
  });

  it('일부만 captured면(2/5) 「측정된 2/5건 기준」 1줄', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ viewsInWindow: PARTIAL_VIEWS });
    expect(container.querySelector('[data-testid="results-summary-organic-views-partial"]')?.textContent).toBe('측정된 2/5건 기준');
  });

  it('⭐views_in_window 없으면(GA4 미연결) 「미측정」+연결 CTA', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ viewsInWindow: null, ga4ConnectionStatus: 'not_connected' });
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')?.textContent).toBe('연결하러 가기');
  });

  it('연결은 됐는데 아직 캡처 0건이면 CTA 없이 「미측정」만', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount({ viewsInWindow: null, ga4ConnectionStatus: 'connected' });
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')).toBeNull();
  });
});

describe('ResultsSummaryCards(story #3979 AC1) — 쓴 광고비 / 남은 한도', () => {
  it('⭐approved_boost_count>0이면 실값(둘 다)', async () => {
    stubCostSummary(MEASURED_ADS);
    await mount();
    await flush();
    expect(container.querySelector('[data-testid="results-summary-ads-spend-value"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-value"]')).not.toBeNull();
  });

  it('⭐approved_boost_count===0이면 둘 다 「미측정」+연결 CTA(0을 그리지 않는다)', async () => {
    stubCostSummary(NO_APPROVED_BOOSTS);
    await mount();
    await flush();
    expect(container.querySelector('[data-testid="results-summary-ads-spend-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-ads-spend-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-ads-spend-cta"]')?.textContent).toBe('연결하러 가기');
  });
});
