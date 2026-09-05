'use client';

import { useLocale, useTranslations } from 'next-intl';

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

/** 분단위(minor) → 화면에 넣을 큰단위(major) 숫자. 입력/표시는 전부 이 값을 쓴다. */
export function minorToMajor(amountMinor: number, currency: GenerationBudgetCurrency): number {
  return amountMinor / 10 ** CURRENCY_EXPONENTS[currency];
}

/** 큰단위(major, 사람이 입력한 값) → 서버로 보낼 분단위(minor) 정수. */
export function majorToMinor(amountMajor: number, currency: GenerationBudgetCurrency): number {
  return Math.round(amountMajor * 10 ** CURRENCY_EXPONENTS[currency]);
}

const CURRENCY_AMOUNT_KEYS: Record<GenerationBudgetCurrency, string> = {
  KRW: 'generationBudgetAmountKrw',
  USD: 'generationBudgetAmountUsd',
};

/** PO REQUIRED①(2026-09-05, PR#3848 리뷰) — 수 묶음(콤마)은 로케일에 안 타는 손
 * 구현(구 commaGroup)이 en 화면에서도 "100,000원"을 그대로 찍는 문제였다. 콤마·자릿수는
 * `Intl.NumberFormat(locale)`(exponent만큼 소수자리 고정)로, 단위/기호(「원」·「$」)는
 * i18n 키(`generationBudgetAmountKrw`/`Usd`)로 — 통화 기호 자체는 번역 대상이 아니라
 * ko/en 두 메시지 파일 모두 같은 접두/접미를 쓰지만, 새 통화가 늘 때 이 표에 한 줄만
 * 늘리면 되게 한다. exponent 표(CURRENCY_EXPONENTS)는 그대로 정본. */
export function formatMinorCurrency(
  amountMinor: number,
  currency: GenerationBudgetCurrency,
  locale: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const major = minorToMajor(amountMinor, currency);
  const exponent = CURRENCY_EXPONENTS[currency];
  const amount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(major);
  return t(CURRENCY_AMOUNT_KEYS[currency], { amount });
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
  const locale = useLocale();

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

  // PO REQUIRED②(2026-09-05, PR#3848 리뷰) — `currency ?? 'KRW'`·`remaining ?? limit-spent`
  // 조립을 FE에서 하지 않는다. 서버가 limitMinor(정책 있음)를 줬는데 currency나
  // remainingMinor가 비어 있으면 그건 서버 응답이 불완전한 것이지 FE가 추정해 채울
  // 값이 아니다 — 특히 currency를 'KRW'로 잘못 추정하면 실은 USD 조직인 경우 §19-1이
  // 막으려던 바로 그 100배 오차가 조용히 난다. 이 경우 failed와 동형으로 취급한다.
  if (state.currency === null || state.remainingMinor === null) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-failed">
        {variant === 'full' ? t('generationBudgetCardCheckFailed') : t('generationBudgetSubmitCheckFailed')}
      </span>
    );
  }
  const currency = state.currency;
  const remainingMinor = state.remainingMinor;

  if (variant === 'compact') {
    // §19-5 — submit 표면은 "남음"만, 분수 아님.
    return (
      <span className="text-xs text-muted-foreground" data-testid="generation-budget-remaining-compact">
        {t('generationBudgetRemainingCompact', { remaining: formatMinorCurrency(remainingMinor, currency, locale, t) })}
      </span>
    );
  }

  // §19-5 — 카드 헤더는 한도/사용/남음 셋을 독립된 값으로(분수 아님 — 남음=한도-사용이라도
  // "사용"이 사라지면 안 되므로 셋 다 그린다). 한도는 기간 접미사를 인라인으로.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="generation-budget-remaining-full">
      <span className="text-muted-foreground">
        {t('generationBudgetLimitLabel')} <span className="text-foreground">{formatMinorCurrency(state.limitMinor, currency, locale, t)} / {t('generationBudgetPeriodMonth')}</span>
      </span>
      <span className="text-muted-foreground">
        {t('generationBudgetSpentLabel')} <span className="text-foreground">{formatMinorCurrency(state.spentMinor, currency, locale, t)}</span>
      </span>
      <span className="text-muted-foreground">
        {t('generationBudgetRemainingLabel')} <span className="text-foreground" data-testid="generation-budget-remaining-value">{formatMinorCurrency(remainingMinor, currency, locale, t)}</span>
      </span>
    </div>
  );
}
