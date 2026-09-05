'use client';

import { useTranslations } from 'next-intl';

// story #3500(BE #3498, PO 確定 2026-09-05·doc a0da40c9 §19 디자인 유나 確定 —
// BE 미착지, 계약만 고정) — 생성 비용 한도(크레딧 게이트) 잔량 표시.
//
// §19-1(⭐최우선 — 통화 소수 자릿수 버그) — KRW exponent=0(1분단위=1원)·USD
// exponent=2(100분단위=$1.00)다. limit_minor를 그대로 찍으면 KRW는 우연히
// 맞아 보이고 USD는 100배로 튄다(테스트가 KRW만 돌리면 안 잡히는 조용한
// 결함류). 변환은 이 파일 한 곳(majorToMinor/minorToMajor)에서만 하고,
// 다른 자리(콘텐츠규칙 카드·잔량 표시 둘·예상비용 입력·422 배너 4값)는
// 전부 이 함수를 통해서만 분단위/큰단위를 오간다 — 어디서도 `/100`을
// 직접 쓰지 않는다.
export type GenerationBudgetCurrency = 'KRW' | 'USD';

const CURRENCY_EXPONENTS: Record<GenerationBudgetCurrency, number> = { KRW: 0, USD: 2 };

function commaGroup(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 분단위(minor) → 화면에 넣을 큰단위(major) 숫자. 입력/표시는 전부 이 값을 쓴다. */
export function minorToMajor(amountMinor: number, currency: GenerationBudgetCurrency): number {
  return amountMinor / 10 ** CURRENCY_EXPONENTS[currency];
}

/** 큰단위(major, 사람이 입력한 값) → 서버로 보낼 분단위(minor) 정수. */
export function majorToMinor(amountMajor: number, currency: GenerationBudgetCurrency): number {
  return Math.round(amountMajor * 10 ** CURRENCY_EXPONENTS[currency]);
}

/** KRW → "50,000원"(정수, 콤마) · USD → "$500.00"(소수 2자리, 콤마, $ 접두). */
export function formatMinorCurrency(amountMinor: number, currency: GenerationBudgetCurrency): string {
  const major = minorToMajor(amountMinor, currency);
  if (currency === 'KRW') {
    return `${commaGroup(Math.round(major).toString())}원`;
  }
  const fixed = major.toFixed(2);
  const [intPart, fracPart] = fixed.split('.');
  return `$${commaGroup(intPart ?? '0')}.${fracPart}`;
}

export type GenerationBudgetState =
  | { status: 'loading' }
  | {
      status: 'ok';
      limitMinor: number | null;
      spentMinor: number;
      remainingMinor: number | null;
      currency: GenerationBudgetCurrency | null;
      period: 'month';
    }
  | { status: 'failed' };

/**
 * `variant="full"` — 생성 비용 한도 카드 헤더(한도·사용·남음 세 값, §19-5).
 * `variant="compact"` — 상신 표면(남음 하나만, §19-5 "submit surface는 남음만").
 *
 * `limitMinor === null`(정책 미설정)이면 이 컴포넌트는 **아무것도 그리지 않는다**
 * (return null, §19-3) — "—"(로딩)와 헷갈리지 않게 하는 장치이기도 하다.
 */
export function GenerationBudgetIndicator({
  state,
  variant,
}: {
  state: GenerationBudgetState;
  variant: 'full' | 'compact';
}) {
  const t = useTranslations('content');

  if (state.status === 'loading') {
    // §19-4 — 로딩은 이 파일 전용 키를 새로 만들지 않는다. status-chip.tsx 등이 이미
    // 쓰는 도메인 무관 "모른다" 표기(originAuthorUnknown="—")를 그대로 재사용한다.
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-loading">
        {t('originAuthorUnknown')}
      </span>
    );
  }

  if (state.status === 'failed') {
    // §19-4 — 자리마다 다른 문구(카드 헤더 vs 상신 표면, 이미 「게시 한도」라는 다른
    // 잔량 표시가 근처에 있어 주어가 필요하다).
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-failed">
        {variant === 'full' ? t('generationBudgetCardCheckFailed') : t('generationBudgetSubmitCheckFailed')}
      </span>
    );
  }

  // ok, but no policy set — 정책 자체가 없다(§19-3 — 줄 자체를 안 그린다, "—"도 "0"도 아님).
  if (state.limitMinor === null) return null;

  if (state.limitMinor === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-suspended">
        {t('generationBudgetSuspended')}
      </span>
    );
  }

  const currency = state.currency ?? 'KRW';
  const remainingMinor = state.remainingMinor ?? state.limitMinor - state.spentMinor;

  if (variant === 'compact') {
    // §19-5 — submit 표면은 "남음"만, 분수 아님.
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-remaining-compact">
        {t('generationBudgetRemainingCompact', { remaining: formatMinorCurrency(remainingMinor, currency) })}
      </span>
    );
  }

  // §19-5 — 카드 헤더는 한도/사용/남음 셋을 독립된 값으로(분수 아님 — 남음=한도-사용이라도
  // "사용"이 사라지면 안 되므로 셋 다 그린다). 한도는 기간 접미사를 인라인으로.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="generation-budget-remaining-full">
      <span className="text-muted-foreground">
        {t('generationBudgetLimitLabel')} <span className="text-foreground">{formatMinorCurrency(state.limitMinor, currency)} / {t('generationBudgetPeriodMonth')}</span>
      </span>
      <span className="text-muted-foreground">
        {t('generationBudgetSpentLabel')} <span className="text-foreground">{formatMinorCurrency(state.spentMinor, currency)}</span>
      </span>
      <span className="text-muted-foreground">
        {t('generationBudgetRemainingLabel')} <span className="text-foreground" data-testid="generation-budget-remaining-value">{formatMinorCurrency(remainingMinor, currency)}</span>
      </span>
    </div>
  );
}
