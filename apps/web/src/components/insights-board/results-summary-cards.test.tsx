// @vitest-environment jsdom
//
// story #3979(AC1) — 첫 화면 요약 4칸(나간 글·자연 조회·쓴 광고비·남은 한도),
// 각 칸 실측/미측정 2갈래(4칸×2). 없는 수를 0으로 안 그린다 — §⑤ 규율 그대로.
//
// story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z, 실결함②) — cost-summary는
// 페이지가 이미 불러 costSummaryState로 내려준다(이 컴포넌트는 더는 자체
// fetch를 안 한다) — 로딩/실패를 「미측정+CTA」로 오분류하지 않는지 각각 확認.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ResultsSummaryCards } from './results-summary-cards';
import type { OrgCostSummaryLoadState } from './org-cost-summary-card';
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
});

const MEASURED_ADS: OrgCostSummaryLoadState = {
  status: 'ok',
  summary: {
    ads: { approved_boost_count: 2, sealed_ads_currency: 'KRW', sealed_budget_minor: 150_000, captured_spend_minor: 12_345, remaining_minor: 137_655, cap_reached_count: 0 },
    generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
    generation_currency: null, x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
  },
};
const NO_APPROVED_BOOSTS: OrgCostSummaryLoadState = {
  status: 'ok',
  summary: {
    ads: { approved_boost_count: 0, sealed_ads_currency: null, sealed_budget_minor: 0, captured_spend_minor: 0, remaining_minor: 0, cap_reached_count: 0 },
    generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
    generation_currency: null, x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
  },
};
const LOADING: OrgCostSummaryLoadState = { status: 'loading' };
const FAILED: OrgCostSummaryLoadState = { status: 'failed' };

const MEASURED_VIEWS: ViewsInWindow = { sum: 4200, captured_rows: 5, total_rows: 5 };
const PARTIAL_VIEWS: ViewsInWindow = { sum: 900, captured_rows: 2, total_rows: 5 };
const MEASURED_PUBLISHED: PublishedInWindow = { count: 7, by_channel: [{ channel_kind: 'threads', count: 7 }], since: '2026-09-10T00:00:00Z' };

async function mount(props: Partial<Parameters<typeof ResultsSummaryCards>[0]> = {}) {
  const onRetryCostSummary = props.onRetryCostSummary ?? vi.fn();
  await act(async () => {
    root.render(wrap(
      <ResultsSummaryCards
        publishedInWindow={props.publishedInWindow ?? null}
        viewsInWindow={props.viewsInWindow ?? null}
        ga4ConnectionStatus={props.ga4ConnectionStatus ?? 'not_connected'}
        boardLoading={props.boardLoading ?? false}
        boardLoadFailed={props.boardLoadFailed ?? false}
        costSummaryState={props.costSummaryState ?? NO_APPROVED_BOOSTS}
        onRetryCostSummary={onRetryCostSummary}
      />,
    ));
  });
  return onRetryCostSummary;
}

describe('ResultsSummaryCards(story #3979 AC1) — 나간 글', () => {
  it('⭐published_in_window 있으면 실값', async () => {
    await mount({ publishedInWindow: MEASURED_PUBLISHED });
    expect(container.querySelector('[data-testid="results-summary-published-value"]')?.textContent).toBe('7');
  });

  it('⭐published_in_window 없으면(3978 미착지 포함) 「미측정」, 0을 안 그린다', async () => {
    await mount({ publishedInWindow: null });
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-published-value"]')).toBeNull();
  });
});

describe('ResultsSummaryCards(story #3979 AC1) — 자연 조회', () => {
  it('⭐views_in_window 있으면 실값(전량 captured면 부분측정 안내 없음)', async () => {
    await mount({ viewsInWindow: MEASURED_VIEWS });
    expect(container.querySelector('[data-testid="results-summary-organic-views-value"]')?.textContent).toBe('4,200');
    expect(container.querySelector('[data-testid="results-summary-organic-views-partial"]')).toBeNull();
  });

  it('일부만 captured면(2/5) 「측정된 2/5건 기준」 1줄', async () => {
    await mount({ viewsInWindow: PARTIAL_VIEWS });
    expect(container.querySelector('[data-testid="results-summary-organic-views-partial"]')?.textContent).toBe('측정된 2/5건 기준');
  });

  it('⭐views_in_window 없으면(GA4 미연결) 「미측정」+연결 CTA', async () => {
    await mount({ viewsInWindow: null, ga4ConnectionStatus: 'not_connected' });
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')?.textContent).toBe('연결하러 가기');
  });

  it('연결은 됐는데 아직 캡처 0건이면 CTA 없이 「미측정」만', async () => {
    await mount({ viewsInWindow: null, ga4ConnectionStatus: 'connected' });
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')).toBeNull();
  });
});

describe('ResultsSummaryCards(story #3979 AC1) — 쓴 광고비 / 남은 한도', () => {
  it('⭐approved_boost_count>0이면 실값(둘 다)', async () => {
    await mount({ costSummaryState: MEASURED_ADS });
    expect(container.querySelector('[data-testid="results-summary-ads-spend-value"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-value"]')).not.toBeNull();
  });

  it('⭐approved_boost_count===0이면 둘 다 「미측정」+연결 CTA(0을 그리지 않는다)', async () => {
    await mount({ costSummaryState: NO_APPROVED_BOOSTS });
    expect(container.querySelector('[data-testid="results-summary-ads-spend-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-ads-spend-value"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-unmeasured"]')?.textContent).toBe('미측정');
    expect(container.querySelector('[data-testid="results-summary-ads-spend-cta"]')?.textContent).toBe('연결하러 가기');
  });
});

// story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z, 실결함②) — adsMeasured가
// 로딩/실패에도 false라 «미측정+CTA»가 매 로드마다 번쩍이던 결함. 3테스트.
describe('ResultsSummaryCards(story #3979 CHANGES) — 로딩·실패는 미측정이 아니다', () => {
  it('⭐로딩 中엔 Skeleton — 「미측정」이 안 뜬다', async () => {
    await mount({ costSummaryState: LOADING });
    expect(container.querySelector('[data-testid="results-summary-ads-spend-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-spend-unmeasured"]')).toBeNull();
  });

  it('⭐실패하면 「불러오지 못했어요」+보이는 재시도 버튼 — 「미측정」이 안 뜬다', async () => {
    await mount({ costSummaryState: FAILED });
    expect(container.querySelector('[data-testid="results-summary-ads-spend-failed"]')?.textContent).toBe('비용 요약을 불러오지 못했어요.');
    expect(container.querySelector('[data-testid="results-summary-ads-spend-unmeasured"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-spend-retry"]')).not.toBeNull();
  });

  it('⭐재시도 버튼 클릭하면 onRetryCostSummary가 정확히 1회 불린다', async () => {
    const onRetryCostSummary = vi.fn();
    await mount({ costSummaryState: FAILED, onRetryCostSummary });
    const retryBtn = container.querySelector('[data-testid="results-summary-ads-spend-retry"]') as HTMLElement;
    await act(async () => { retryBtn.click(); });
    expect(onRetryCostSummary).toHaveBeenCalledTimes(1);
  });

  // 페드루 PO 선택 사항(2026-09-17 01:32Z) — 같은 요청 하나에 재시도 버튼 2개는
  // 중복이라 「쓴 광고비」에만 두고 「남은 한도」는 문구만.
  it('실패해도 「남은 한도」엔 재시도 버튼이 없다(같은 요청, 중복 제거)', async () => {
    await mount({ costSummaryState: FAILED });
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-failed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-ads-remaining-retry"]')).toBeNull();
  });
});

// story #3979 CHANGES r2(페드루 PO 2026-09-17 01:32Z, 실결함) — 나간 글·자연
// 조회도 같은 클래스: publishedInWindow/viewsInWindow는 로딩 中·실패 뒤에도
// 똑같이 null이라 「미측정」(자연 조회는 CTA까지)이 번쩍였다. 3테스트.
describe('ResultsSummaryCards(story #3979 CHANGES r2) — 나간 글·자연 조회도 로딩·실패는 미측정이 아니다', () => {
  it('⭐로딩 中엔 두 칸 다 Skeleton — 「미측정」이 안 뜬다', async () => {
    await mount({ boardLoading: true });
    expect(container.querySelector('[data-testid="results-summary-published-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')).toBeNull();
  });

  it('⭐실패하면 두 칸 다 「불러오지 못했어요」 문구 — 「미측정」·연결 CTA가 안 뜬다(재시도는 페이지 Alert가 이미 있다)', async () => {
    await mount({ boardLoadFailed: true, ga4ConnectionStatus: 'not_connected' });
    expect(container.querySelector('[data-testid="results-summary-published-failed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-failed"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')).toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-cta"]')).toBeNull();
  });

  it('로딩도 실패도 아닌데 ok+null이면(정말 미측정) 그대로 「미측정」', async () => {
    await mount({ boardLoading: false, boardLoadFailed: false, publishedInWindow: null, viewsInWindow: null });
    expect(container.querySelector('[data-testid="results-summary-published-unmeasured"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="results-summary-organic-views-unmeasured"]')).not.toBeNull();
  });
});
