// @vitest-environment jsdom
//
// story #3979(자리 옮김 ②) — 일별 광고비 지출 막대(PaidSpendDailySeriesCard,
// 기존 그대로)가 「광고 상한」 카드 펼침 안으로. 기본 접힘 — 펼치기 전엔 그
// 카드 자체가 마운트되지 않는다(불필요한 fetch 방지), 펼치면 나타난다.
//
// story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z, 실결함③) — cost-summary는
// 페이지가 1회만 불러 costSummaryState로 내려준다(OrgCostSummaryCard도 이
// preloadedState를 받아 자체 fetch를 안 한다 — AC3 ≤2콜). 접힌 머리에도
// 「상한 도달 N건」이 미리 보인다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AdsCapCard } from './ads-cap-card';
import type { OrgCostSummaryLoadState } from './org-cost-summary-card';

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
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: { currency: 'KRW', points: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const NO_CAP: OrgCostSummaryLoadState = {
  status: 'ok',
  summary: {
    ads: { approved_boost_count: 2, sealed_ads_currency: 'KRW', sealed_budget_minor: 100_000, captured_spend_minor: 10_000, remaining_minor: 90_000, cap_reached_count: 0, connection_status: 'connected' },
    generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
    generation_currency: null, x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
  },
};
const CAP_REACHED: OrgCostSummaryLoadState = {
  status: 'ok',
  summary: {
    ads: { approved_boost_count: 2, sealed_ads_currency: 'KRW', sealed_budget_minor: 100_000, captured_spend_minor: 100_000, remaining_minor: 0, cap_reached_count: 3, connection_status: 'connected' },
    generation_cost_spent_minor: null, generation_cost_period_start: null, generation_cost_period_end: null,
    generation_currency: null, x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
  },
};

describe('AdsCapCard(story #3979)', () => {
  it('⭐기본 접힘 — 펼치기 전엔 차트 카드가 마운트되지 않는다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" costSummaryState={NO_CAP} />)); });
    expect(container.querySelector('[data-testid="ads-cap-card-body"]')).toBeNull();
    expect(container.querySelector('[data-testid="ads-cap-card-toggle"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('⭐토글 클릭하면 펼쳐져 기존 PaidSpendDailySeriesCard·OrgCostSummaryCard가 그대로 나타난다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" costSummaryState={NO_CAP} />)); });
    const toggle = container.querySelector('[data-testid="ads-cap-card-toggle"]') as HTMLElement;
    await act(async () => { toggle.click(); });
    await flush();
    expect(container.querySelector('[data-testid="ads-cap-card-body"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-card"], [data-testid="paid-spend-daily-series-card-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="org-cost-summary-card"], [data-testid="org-cost-summary-card-loading"]')).not.toBeNull();
  });

  it('⭐상한 도달 0건이면 머리에 개수 문구가 없다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" costSummaryState={NO_CAP} />)); });
    expect(container.querySelector('[data-testid="ads-cap-card-reached-count"]')).toBeNull();
  });

  it('⭐상한 도달 N건이면 접힌 머리에도 미리 보인다', async () => {
    await act(async () => { root.render(wrap(<AdsCapCard orgId="org-1" costSummaryState={CAP_REACHED} />)); });
    expect(container.querySelector('[data-testid="ads-cap-card-reached-count"]')?.textContent).toContain('3');
    expect(container.querySelector('[data-testid="ads-cap-card-body"]')).toBeNull();
  });
});
