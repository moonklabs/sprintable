'use client';

import { useLocale, useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatMinorCurrency, formatRemainingWithOverLimit, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';

// story #3808(PR5c, 페드루 PO 確定 2026-09-12 — 라이브 회차 결함 처방) —
// GenerationBudgetExceededBanner의 형제 컴포넌트(다른 지갑, api-usage-budget-
// indicator.tsx가 generation-budget-indicator.tsx의 형제인 것과 동형 관례).
// 두 축(생성 비용·X 비용)이 같은 BE 예외(GenerationBudgetExceededError,
// rule_key만 다름)를 공유해 왔는데, 화면까지 같은 배너·같은 "생성 비용 한도를
// 넘습니다" 문구를 재사용하면 X 상한 초과인데 "생성 비용" 축으로 오라벨된다
// (실측, 배포79 라이브 회차 — X 축이 발행 422를 받았는데 배너가 생성 비용을
// 말했다). 문구만 X 축("X 비용")으로 바꾼 별도 컴포넌트로 분리한다.
export function ApiUsageBudgetExceededBanner({
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
    <Alert variant="destructive" role="alert" data-testid="api-usage-budget-exceeded-banner">
      <AlertDescription>
        <span className="block">{t('apiUsageBudgetExceededFact')}</span>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">{t('apiUsageBudgetLimitLabel')}</span>
          <span data-testid="api-usage-budget-exceeded-limit">{formatMinorCurrency(limitMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('apiUsageBudgetSpentLabel')}</span>
          <span data-testid="api-usage-budget-exceeded-spent">{formatMinorCurrency(spentMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('generationBudgetEstimatedLabel')}</span>
          <span data-testid="api-usage-budget-exceeded-estimated">{formatMinorCurrency(estimatedCostMinor, currency, locale, t)}</span>
          <span className="text-muted-foreground">{t('apiUsageBudgetRemainingLabel')}</span>
          <span data-testid="api-usage-budget-exceeded-remaining">{formatRemainingWithOverLimit(remainingMinor, currency, locale, t)}</span>
        </div>
        <span className="mt-2 block text-xs text-muted-foreground">{t('apiUsageBudgetExceededAction')}</span>
      </AlertDescription>
    </Alert>
  );
}
