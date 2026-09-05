'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';

// story #3500(BE #3498, PO 確定·doc a0da40c9 §19-8 디자인 유나 確定 2026-09-05 —
// BE 미착지, 계약만 고정) — GENERATION_BUDGET_EXCEEDED 422 전역 배너. §19-8이
// 요구하는 구조(사실 문장 → 4값 두 칸 목록 → 행동 문장)를 재사용 가능한 컴포넌트로
// 뽑아 둔다 — submit-time 422와 발행 결과 재검사 실패(승인 뒤 다른 지출로 잔량이
// 줄어든 경우) 둘 다 같은 배너를 쓸 수 있게(§19-8-5). 이 스켈레톤 패스에선
// submit-time 자리만 배선하고, 발행 결과 표면 배선은 후속(PR 본문에 명시).
export function GenerationBudgetExceededBanner({
  limitMinor,
  spentMinor,
  estimatedCostMinor,
  remainingMinor,
  currency,
}: {
  limitMinor: number;
  spentMinor: number;
  estimatedCostMinor: number;
  remainingMinor: number;
  currency: GenerationBudgetCurrency;
}) {
  const t = useTranslations('content');
  const locale = useLocale();
  return (
    // AlertDescription 자체가 <p> 루트다(components/ui/alert.tsx) — 그 안에 <p>·<dl>
    // 같은 블록 요소를 또 넣으면 무효 HTML(<p> 안 <p>)이 된다. 전부 <span>/<div>로.
    <Alert variant="destructive" role="alert" data-testid="generation-budget-exceeded-banner">
      <AlertDescription>
        <span className="block">{t('generationBudgetExceededFact')}</span>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" role="list">
          <span className="text-muted-foreground">{t('generationBudgetLimitLabel')}</span>
          <span data-testid="generation-budget-exceeded-limit">{formatMinorCurrency(limitMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('generationBudgetSpentLabel')}</span>
          <span data-testid="generation-budget-exceeded-spent">{formatMinorCurrency(spentMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('generationBudgetEstimatedLabel')}</span>
          <span data-testid="generation-budget-exceeded-estimated">{formatMinorCurrency(estimatedCostMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('generationBudgetRemainingLabel')}</span>
          <span data-testid="generation-budget-exceeded-remaining">{formatMinorCurrency(remainingMinor, currency, locale, t)}</span>
        </div>
        <span className="mt-2 block text-xs text-muted-foreground">{t('generationBudgetExceededAction')}</span>
      </AlertDescription>
    </Alert>
  );
}
