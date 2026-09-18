'use client';

import type { useTranslations } from 'next-intl';
import type { AdsBoostSummaryView } from './types';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';

// story #3806(Phase3·3-2 PR5 조각⑥, 유나 §절 §3 「성과 보드 «광고비» 분리 칸」) —
// insights-board-metric-cell.tsx의 「네 갈래 셀 관례」를 그대로 재사용(§절 원문:
// 「해당 없음」/「집계 대기」/「미제공」/「값」). 이 셀은 단일 지표가 아니라 예산 대비
// 지출 복합값이라 InsightsBoardMetricCell을 통째로 재사용하지 않고 같은 4갈래
// 판정 구조만 빌린다(그 컴포넌트 docstring이 이미 「통째로 재사용 안 함」 선례를
// 남겼다 — insight-snapshot-block.tsx 대 그 컴포넌트와 동형 관계).
//
// 상태 판정(BE가 주는 신호만으로, 지어내지 않는다):
//   ① adsBoost === null           → 「해당 없음」(이 발행물에 홍보 요청 자체가 없음)
//   ② run_status ∈ {null,'pending'} → 「집계 대기」(요청·승인은 됐으나 아직 실행 前)
//   ③ run_status === 'failed'     → 「미제공」(실행이 실패해 값을 못 낸다)
//   ④ run_status ∈ {'running','paused'} → 값(광고비 {지출} / {승인예산} + 잔여,
//      잔여 음수는 「초과」)

export interface AdsSpendCellProps {
  adsBoost: AdsBoostSummaryView | null;
  tBoard: ReturnType<typeof useTranslations>;
  tContent: ReturnType<typeof useTranslations>;
  locale: string;
}

export function AdsSpendCell({ adsBoost, tBoard, tContent, locale }: AdsSpendCellProps) {
  // 방어적 — 타입은 null만 선언하지만(BE Pydantic 계약상 항상 present), 목 fetch
  // 응답류(컴파일타임 미검증 JSON 리터럴)는 필드 자체가 빠진 undefined로 올 수 있다.
  if (!adsBoost) {
    return <span className="text-muted-foreground" data-testid="ads-spend-cell-none">{tBoard('adsSpendNotApplicable')}</span>;
  }

  if (adsBoost.run_status === 'failed') {
    return <span className="text-muted-foreground" data-testid="ads-spend-cell-unavailable">{tBoard('adsSpendUnavailable')}</span>;
  }

  if (adsBoost.run_status === null || adsBoost.run_status === 'pending') {
    return <span className="text-muted-foreground" data-testid="ads-spend-cell-pending">{tBoard('adsSpendAggregationPending')}</span>;
  }

  const currency = adsBoost.sealed_currency as GenerationBudgetCurrency | null;
  const spendDisplay = currency
    ? formatMinorCurrency(adsBoost.captured_spend_minor, currency, locale, tContent)
    : String(adsBoost.captured_spend_minor);
  const budgetDisplay = currency && adsBoost.sealed_budget_minor !== null
    ? formatMinorCurrency(adsBoost.sealed_budget_minor, currency, locale, tContent)
    : null;
  const exceeded = adsBoost.remaining_minor < 0;
  const remainingAbsDisplay = currency
    ? formatMinorCurrency(Math.abs(adsBoost.remaining_minor), currency, locale, tContent)
    : String(Math.abs(adsBoost.remaining_minor));

  return (
    <span data-testid="ads-spend-cell-value">
      <span className="text-foreground">
        {budgetDisplay
          ? tBoard('adsSpendLine', { spend: spendDisplay, budget: budgetDisplay })
          : spendDisplay}
      </span>
      <span className={`ml-1 text-xs ${exceeded ? 'text-destructive' : 'text-muted-foreground'}`}>
        {exceeded
          ? tBoard('adsSpendExceeded', { amount: remainingAbsDisplay })
          : tBoard('adsSpendRemaining', { amount: remainingAbsDisplay })}
      </span>
    </span>
  );
}
