// @vitest-environment jsdom
//
// story #3809(Phase3·3-7 PR 4b, 페드루 PO 確定 2026-09-11 23:xxZ) — 일별 paid
// 지출 시계열 카드. PO 3대 규율(캡처된 날짜만·「캡처 시점 기준」 라벨·연속성
// 주장 0) + 통화 안전(PR2b 동형, 섞인 날짜는 숫자 0)을 화면 테스트로 닫는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { PaidSpendDailySeriesCard } from './paid-spend-daily-series-card';

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

function stubFetchOk(paid_spend_daily_series: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: { paid_spend_daily_series } }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ));
}

function stubFetchFailed(status = 500) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ data: null, error: { code: 'FAILED' } }), { status }),
  ));
}

const SINGLE_DAY_KRW = [
  { date: '2026-09-10', spend_minor: 12_345, currency: 'KRW', source: 'paid' },
];

const TWO_DAYS_KRW = [
  { date: '2026-09-10', spend_minor: 12_345, currency: 'KRW', source: 'paid' },
  { date: '2026-09-11', spend_minor: 24_690, currency: 'KRW', source: 'paid' },
];

const MIXED_DAY = [
  { date: '2026-09-10', spend_minor: null, currency: null, source: 'paid' },
];

describe('PaidSpendDailySeriesCard(story #3809, PR4b)', () => {
  it('로딩 중엔 스켈레톤만', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    expect(container.querySelector('[data-testid="paid-spend-daily-series-card-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-card"]')).toBeNull();
  });

  it('로드 실패 — 실패 문구만', async () => {
    stubFetchFailed(500);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-card-failed"]')?.textContent).toBe('일별 지출을 불러오지 못했습니다.');
  });

  it('캡처 0건 — 「표시할 캡처가 없습니다」만, 막대 0개', async () => {
    stubFetchOk([]);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-empty"]')?.textContent).toBe('표시할 지출 캡처가 아직 없습니다.');
    expect(container.querySelectorAll('[data-testid="paid-spend-daily-series-point"]').length).toBe(0);
  });

  it('캡처 1건(단일 통화) — 막대 1개, 라벨에 「캡처 시점 기준」 캡션이 항상 붙는다', async () => {
    stubFetchOk(SINGLE_DAY_KRW);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    await flush();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-caption"]')?.textContent).toBe('캡처 시점 기준 — 매일 자동 수집을 보장하지 않습니다.');
    const points = container.querySelectorAll('[data-testid="paid-spend-daily-series-point"]');
    expect(points.length).toBe(1);
    expect(points[0].getAttribute('data-mixed')).toBe('false');
    expect(container.querySelector('[data-testid="paid-spend-daily-series-point-bar"]')).not.toBeNull();
  });

  it('캡처 여러 날 — 캡처된 날짜만 정확히 그 개수만큼(연속성 채움 0)', async () => {
    stubFetchOk(TWO_DAYS_KRW);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    await flush();
    const points = container.querySelectorAll('[data-testid="paid-spend-daily-series-point"]');
    expect(points.length).toBe(2);
    expect(container.querySelector('[data-date="2026-09-10"]')).not.toBeNull();
    expect(container.querySelector('[data-date="2026-09-11"]')).not.toBeNull();
    // 연속성 주장 0 — 막대를 잇는 선(svg line/polyline) 요소가 없다.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('⭐통화 섞인 날짜 — 숫자 0(raw·null 텍스트 안 새어나감), 점 표시만', async () => {
    stubFetchOk(MIXED_DAY);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />)); });
    await flush();
    const point = container.querySelector('[data-testid="paid-spend-daily-series-point"]');
    expect(point?.getAttribute('data-mixed')).toBe('true');
    expect(container.querySelector('[data-testid="paid-spend-daily-series-point-mixed-dot"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-point-bar"]')).toBeNull();
    expect(container.textContent).not.toContain('null');
  });

  it('en 로케일 — 캡션·빈 상태 문구가 영문으로 렌더', async () => {
    stubFetchOk([]);
    await act(async () => { root.render(wrap(<PaidSpendDailySeriesCard orgId="org-1" />, 'en')); });
    await flush();
    expect(container.querySelector('[data-testid="paid-spend-daily-series-caption"]')?.textContent).toBe('As of capture time — daily collection isn\'t guaranteed.');
    expect(container.querySelector('[data-testid="paid-spend-daily-series-empty"]')?.textContent).toBe('No spend captures to show yet.');
  });
});
