// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider, useLocale, useTranslations } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AdsSpendCell } from './ads-spend-cell';
import type { AdsBoostSummaryView } from './types';

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

function mount(adsBoost: AdsBoostSummaryView | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(wrap(
      <table><tbody><tr><td>
        <AdsSpendCellHarness adsBoost={adsBoost} />
      </td></tr></tbody></table>,
    ));
  });
}

function AdsSpendCellHarness({ adsBoost }: { adsBoost: AdsBoostSummaryView | null }) {
  const tBoard = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const locale = useLocale();
  return <AdsSpendCell adsBoost={adsBoost} tBoard={tBoard} tContent={tContent} locale={locale} />;
}

// story #3806(Phase3·3-2 PR5 조각⑥, 유나 §절 §3 「네 갈래」) — 「해당 없음」/「집계
// 대기」/「미제공」/「값」 전부 실 DOM 렌더 검증(순수함수 테스트만으론 실제로
// 그려지는지 못 잡는다, #2814 동일 근거).
describe('AdsSpendCell — story #3806(Phase3·3-2 PR5 조각⑥)', () => {
  it('⭐adsBoost=null → 「해당 없음」', () => {
    mount(null);
    expect(container.querySelector('[data-testid="ads-spend-cell-none"]')?.textContent)
      .toBe(koMessages.insightsBoard.adsSpendNotApplicable);
  });

  it('⭐run_status=null(미시작) → 「집계 대기」', () => {
    mount({
      gate_id: 'gate-1', gate_status: 'approved', sealed_budget_minor: 50_000, sealed_currency: 'KRW',
      captured_spend_minor: 0, remaining_minor: 50_000, run_status: null,
    });
    expect(container.querySelector('[data-testid="ads-spend-cell-pending"]')?.textContent)
      .toBe(koMessages.insightsBoard.adsSpendAggregationPending);
  });

  it('⭐run_status="failed" → 「미제공」', () => {
    mount({
      gate_id: 'gate-1', gate_status: 'approved', sealed_budget_minor: 50_000, sealed_currency: 'KRW',
      captured_spend_minor: 0, remaining_minor: 50_000, run_status: 'failed',
    });
    expect(container.querySelector('[data-testid="ads-spend-cell-unavailable"]')?.textContent)
      .toBe(koMessages.insightsBoard.adsSpendUnavailable);
  });

  it('⭐run_status="running"·잔여 양수 → 「광고비 {지출} / {승인예산}」 + 「잔여 {금액}」', () => {
    mount({
      gate_id: 'gate-1', gate_status: 'approved', sealed_budget_minor: 50_000, sealed_currency: 'KRW',
      captured_spend_minor: 30_000, remaining_minor: 20_000, run_status: 'running',
    });
    const el = container.querySelector('[data-testid="ads-spend-cell-value"]');
    expect(el?.textContent).toContain('30,000원');
    expect(el?.textContent).toContain('50,000원');
    expect(el?.textContent).toContain('20,000원');
    expect(el?.textContent).not.toContain(koMessages.insightsBoard.adsSpendExceeded.split(' ')[0]);
  });

  it('⭐run_status="paused"도 값을 그린다(중지됨=실행 이력 있음, 「미제공」 아님)', () => {
    mount({
      gate_id: 'gate-1', gate_status: 'approved', sealed_budget_minor: 50_000, sealed_currency: 'KRW',
      captured_spend_minor: 10_000, remaining_minor: 40_000, run_status: 'paused',
    });
    expect(container.querySelector('[data-testid="ads-spend-cell-value"]')).not.toBeNull();
  });

  it('⭐잔여 음수 → 「초과」로 바뀐다(「잔여」 아님)', () => {
    mount({
      gate_id: 'gate-1', gate_status: 'approved', sealed_budget_minor: 50_000, sealed_currency: 'KRW',
      captured_spend_minor: 55_000, remaining_minor: -5_000, run_status: 'running',
    });
    const el = container.querySelector('[data-testid="ads-spend-cell-value"]');
    expect(el?.textContent).toContain('5,000원');
    expect(el?.textContent).toMatch(/초과/);
    expect(el?.textContent).not.toMatch(/잔여/);
  });
});
