// @vitest-environment jsdom
//
// story #3809(Phase3·3-7 PR 3, 페드루 PO 確定 2026-09-11 19:00Z) — 조직 비용
// 원장 카드. PO 명시 요청: 라이브 캡처(dev-app, PR2b 착지+배포75 뒤)에 앞서
// «null/단일 통화 두 분기»를 vitest 화면 테스트로 먼저 닫아 둔다 — 아래
// 「양성대조」 두 건이 그 요청의 실물(단일 KRW·섞임 null).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { OrgCostSummaryCard } from './org-cost-summary-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function wrap(node: React.ReactNode, locale: 'ko' | 'en' = 'ko') {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
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

function stubFetchOk(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
}

function stubFetchFailed(status = 500) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: null, error: { code: 'FAILED' } }), { status }),
  ));
}

const NO_APPROVED_BOOSTS = {
  ads: {
    approved_boost_count: 0, sealed_ads_currency: null, sealed_budget_minor: 0,
    captured_spend_minor: 0, remaining_minor: 0, cap_reached_count: 0,
  },
  generation_cost_spent_minor: null, generation_cost_period_start: null,
  generation_cost_period_end: null, generation_currency: null,
  x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
};

const SINGLE_CURRENCY = {
  ads: {
    approved_boost_count: 2, sealed_ads_currency: 'KRW', sealed_budget_minor: 150_000,
    captured_spend_minor: 12_345, remaining_minor: 137_655, cap_reached_count: 0,
  },
  generation_cost_spent_minor: 5_000, generation_cost_period_start: '2026-09-01T00:00:00Z',
  generation_cost_period_end: '2026-09-30T23:59:59Z', generation_currency: 'KRW',
  x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
};

const MIXED_CURRENCY = {
  ads: {
    approved_boost_count: 2, sealed_ads_currency: null, sealed_budget_minor: null,
    captured_spend_minor: null, remaining_minor: null, cap_reached_count: 1,
  },
  generation_cost_spent_minor: null, generation_cost_period_start: null,
  generation_cost_period_end: null, generation_currency: null,
  x_cost_spent_minor: null, x_cost_period_start: null, x_cost_period_end: null, x_currency: null,
};

describe('OrgCostSummaryCard(story #3809, PR3)', () => {
  it('로딩 중엔 스켈레톤만(값 0건도 아니고, 문구도 아직 없음)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    expect(container.querySelector('[data-testid="org-cost-summary-card-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="org-cost-summary-card"]')).toBeNull();
  });

  it('로드 실패 — 실패 문구, 0이나 raw 숫자로 지어내지 않는다', async () => {
    stubFetchFailed(500);
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-summary-card-failed"]')?.textContent).toBe('비용 요약을 불러오지 못했습니다.');
  });

  it('승인된 광고 홍보 0건 — 「없습니다」만, 0을 숫자로 안 그린다', async () => {
    stubFetchOk(NO_APPROVED_BOOSTS);
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-ads-none"]')?.textContent).toBe('승인된 광고 홍보가 없습니다.');
    expect(container.querySelector('[data-testid="org-cost-ads-amounts"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-cost-ads-currency-mixed"]')).toBeNull();
    // story #3809(PO 라이브 캡처 정정 2026-09-11 20:57Z+유나 정정 21:00Z) — 정책
    // 없으면(null) 줄 자체를 지우던 걸 되돌림(X축은 항상 「아직 측정 안 됨」 줄이
    // 있는데 이 축만 침묵하면 0/미측정을 못 가른다) — X와 같은 결의 문장으로.
    expect(container.querySelector('[data-testid="org-cost-generation-unmeasured"]')?.textContent).toBe('생성 비용은 아직 측정되지 않습니다.');
    expect(container.querySelector('[data-testid="org-cost-x-cost-unmeasured"]')?.textContent).toBe('X 비용은 아직 측정되지 않습니다.');
  });

  it('⭐생성 비용 정책은 있고 이 기간 지출 0 — 특별 문장 없이 그냥 「생성 비용 0원」(0 특별취급 과잉, 유나 지적)', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      generation_cost_spent_minor: 0, generation_currency: 'KRW',
      generation_cost_period_start: '2026-09-01T00:00:00Z', generation_cost_period_end: '2026-09-30T23:59:59Z',
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-generation-amount"]')?.textContent).toBe('생성 비용 0원');
    expect(container.querySelector('[data-testid="org-cost-generation-unmeasured"]')).toBeNull();
  });

  it('⭐양성대조① 단일 통화(KRW) — formatMinorCurrency로 실제 합계를 그린다(원화 소수점 0자리)', async () => {
    stubFetchOk(SINGLE_CURRENCY);
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-ads-approved-count"]')?.textContent).toBe('승인된 광고 홍보 2건');
    expect(container.querySelector('[data-testid="org-cost-ads-currency-mixed"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-cost-ads-amounts"]')?.textContent).toBe('예산 150,000원 · 지출 12,345원 · 잔여 137,655원');
    expect(container.querySelector('[data-testid="org-cost-generation-amount"]')?.textContent).toBe('생성 비용 5,000원');
  });

  it('⭐양성대조② 통화 섞임(null) — 지어낸 숫자·raw 값 없이 안전 문구만, cap_reached는 별개 축이라 계속 보인다', async () => {
    stubFetchOk(MIXED_CURRENCY);
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-ads-approved-count"]')?.textContent).toBe('승인된 광고 홍보 2건');
    expect(container.querySelector('[data-testid="org-cost-ads-currency-mixed"]')?.textContent).toBe('통화가 섞여 합계를 표시하지 않습니다.');
    expect(container.querySelector('[data-testid="org-cost-ads-amounts"]')).toBeNull();
    // null을 어떤 형태로든(0·"null"·raw) 숫자로 새어 보이지 않는다.
    expect(container.textContent).not.toContain('null');
    expect(container.querySelector('[data-testid="org-cost-ads-cap-reached"]')?.textContent).toBe('상한 도달 1건');
  });

  it('생성 비용 값은 있는데 통화가 없음(서버 응답 불완전) — 실패 문구로 접는다(KRW 추정 금지, PR#3848 PO 지침②)', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      generation_cost_spent_minor: 3_000, generation_currency: null,
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-generation-failed"]')?.textContent).toBe('생성 비용 정보를 확인하지 못했습니다.');
    expect(container.querySelector('[data-testid="org-cost-generation-amount"]')).toBeNull();
  });

  it('en 로케일 — 단일 통화 카드가 영문 메시지로 렌더', async () => {
    stubFetchOk(SINGLE_CURRENCY);
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />, 'en')); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-ads-amounts"]')?.textContent).toBe('Budget ₩150,000 · Spent ₩12,345 · Remaining ₩137,655');
  });

  // story #3808(PR5c, 페드루 PO 確定 2026-09-12 — 라이브 회차 결함 처방) — 아래
  // 3건은 generation 축 테스트(116·150줄)와 정확히 동형(같은 3분기: 미측정/실값/
  // 통화실패). x_cost_spent_minor가 BE 하드코딩 None이던 시절엔 이 3건이 전부
  // 존재할 수 없었다(항상 위 「미측정」한 갈래뿐) — non-null 분기 자체가 신설.

  it('⭐X 비용 정책은 있고 지출 0 — 특별 문장 없이 그냥 「X 비용 0원」(generation 0원 동형)', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      x_cost_spent_minor: 0, x_currency: 'KRW',
      x_cost_period_start: '2026-09-01T00:00:00Z', x_cost_period_end: '2026-09-30T23:59:59Z',
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-x-cost-amount"]')?.textContent).toBe('X 비용 0원');
    expect(container.querySelector('[data-testid="org-cost-x-cost-unmeasured"]')).toBeNull();
  });

  it('⭐X 비용 실측값(양수) — formatMinorCurrency로 실제 지출을 그린다', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      x_cost_spent_minor: 300, x_currency: 'KRW',
      x_cost_period_start: '2026-09-01T00:00:00Z', x_cost_period_end: '2026-09-30T23:59:59Z',
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-x-cost-amount"]')?.textContent).toBe('X 비용 300원');
    expect(container.querySelector('[data-testid="org-cost-x-cost-unmeasured"]')).toBeNull();
    expect(container.querySelector('[data-testid="org-cost-x-cost-failed"]')).toBeNull();
  });

  it('X 비용 값은 있는데 통화가 없음(서버 응답 불완전) — 실패 문구로 접는다(KRW 추정 금지)', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      x_cost_spent_minor: 300, x_currency: null,
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-x-cost-failed"]')?.textContent).toBe('X 비용 정보를 확인하지 못했습니다.');
    expect(container.querySelector('[data-testid="org-cost-x-cost-amount"]')).toBeNull();
  });

  it('en 로케일 — X 비용 실측값이 영문 메시지로 렌더', async () => {
    stubFetchOk({
      ...NO_APPROVED_BOOSTS,
      x_cost_spent_minor: 300, x_currency: 'KRW',
      x_cost_period_start: '2026-09-01T00:00:00Z', x_cost_period_end: '2026-09-30T23:59:59Z',
    });
    await act(async () => { root.render(wrap(<OrgCostSummaryCard orgId="org-1" />, 'en')); });
    await flush();
    expect(container.querySelector('[data-testid="org-cost-x-cost-amount"]')?.textContent).toBe('X cost ₩300');
  });
});
