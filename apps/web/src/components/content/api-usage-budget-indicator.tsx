'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatMinorCurrency, formatRemainingWithOverLimit, type GenerationBudgetCurrency } from './generation-budget-indicator';

// story #3808(Phase3·3-3 PR5a, 페드루 PO 確定 2026-09-12) — X 종량 API 지출 월 상한
// 잔량 표시. `generation-budget-indicator.tsx::GenerationBudgetIndicator`의 형제
// 컴포넌트(페드루 PO 지시 "i18n 키 복제" — 별도 지갑이라 새 컴포넌트, 통화 변환
// 유틸(minorToMajor/majorToMinor/formatMinorCurrency)만 그 파일에서 재사용).
//
// BE 계약(story #3808 PR3, `GET .../api-usage-budget`) — generation-budget과 완전
// 동형 응답 모양({limit_minor,currency,period,period_start,period_end,spent_minor,
// remaining_minor}, 전부 정책 없으면 null) — GenerationBudgetState와 같은 형.
export type ApiUsageBudgetState =
  | { status: 'loading' }
  | {
      status: 'ok';
      limitMinor: number | null;
      spentMinor: number | null;
      remainingMinor: number | null;
      currency: GenerationBudgetCurrency | null;
      period: 'month';
    }
  | { status: 'failed' };

/**
 * `variant="full"` — 카드 헤더(한도·사용·남음).
 * `variant="compact"` — 상신 표면(남음 하나만).
 *
 * `limitMinor === null`(정책 미설정)이면 **아무것도 그리지 않는다**(return null) —
 * GenerationBudgetIndicator와 동일 규율: "정책 없음"과 "0"을 같은 얼굴로 안 그린다.
 */
export function ApiUsageBudgetIndicator({
  state,
  variant,
}: {
  state: ApiUsageBudgetState;
  variant: 'full' | 'compact';
}) {
  const t = useTranslations('content');
  const locale = useLocale();

  if (state.status === 'loading') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="api-usage-budget-loading">
        {t('originAuthorUnknown')}
      </span>
    );
  }

  if (state.status === 'failed') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="api-usage-budget-failed">
        {variant === 'full' ? t('apiUsageBudgetCardCheckFailed') : t('apiUsageBudgetSubmitCheckFailed')}
      </span>
    );
  }

  if (state.limitMinor === null) return null;

  if (state.limitMinor === 0) {
    // story #3808(PR5a CHANGES, 유나 04:12Z issuecomment-5643378724 + PO 정지 org
    // 캡처) — "정지" 두 글자만 홀로 서면 「어느 축이·왜·무엇이 멈추나」 셋 다
    // 안 보인다(compact 잔량 축-이름-누락과 같은 클래스). 축 이름("X 비용")·
    // 0 한도 값·정지 대상(발행)을 한 줄에 함께 싣는다.
    return (
      <span className="text-xs text-muted-foreground" data-testid="api-usage-budget-suspended">
        {t('apiUsageBudgetSuspended', { limit: formatMinorCurrency(0, state.currency ?? 'KRW', locale, t) })}
      </span>
    );
  }

  if (state.currency === null || state.remainingMinor === null || state.spentMinor === null) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="api-usage-budget-failed">
        {variant === 'full' ? t('apiUsageBudgetCardCheckFailed') : t('apiUsageBudgetSubmitCheckFailed')}
      </span>
    );
  }
  const currency = state.currency;
  const remainingMinor = state.remainingMinor;

  if (variant === 'compact') {
    return (
      <span className="text-xs text-muted-foreground" data-testid="api-usage-budget-remaining-compact">
        {t('apiUsageBudgetRemainingCompact', { remaining: formatRemainingWithOverLimit(remainingMinor, currency, locale, t) })}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="api-usage-budget-remaining-full">
      <span className="text-muted-foreground">
        {t('apiUsageBudgetLimitLabel')} <span className="text-foreground">{formatMinorCurrency(state.limitMinor, currency, locale, t)} / {t('apiUsageBudgetPeriodMonth')}</span>
      </span>
      <span className="text-muted-foreground">
        {t('apiUsageBudgetSpentLabel')} <span className="text-foreground">{formatMinorCurrency(state.spentMinor, currency, locale, t)}</span>
      </span>
      <span className="text-muted-foreground">
        {t('apiUsageBudgetRemainingLabel')} <span className="text-foreground" data-testid="api-usage-budget-remaining-value">{formatRemainingWithOverLimit(remainingMinor, currency, locale, t)}</span>
      </span>
    </div>
  );
}
