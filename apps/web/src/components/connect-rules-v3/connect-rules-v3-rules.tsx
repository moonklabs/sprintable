'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';

/**
 * story #3982 §(e) 콘텐츠 규칙 — 「첫 화면 콜 ≤5(A 제외)」 예산을 지키려고 별도
 * `/generation-budget`·`/api-usage-budget` GET을 새로 부르지 않는다: `GET .../
 * content-rules`(ContentRulesFields, `app/routers/content_rules.py:123`) 응답에
 * 이미 `generation_budget`/`api_usage_budget`/`utm_rules`가 정책값(limit_minor·
 * currency·period)으로 실려 온다 — 이 화면은 spent/remaining이 필요 없어(설정
 * 금액·기간만 보여주면 됨, 낱말표 D절) 그 계산까지 하는 별도 GET은 과한 콜이다.
 * 낱말표 D절 정본: 한도는 켜짐/꺼짐이 아니라 «설정 금액·기간 / 없으면 「없음」»으로
 * 표시하고, 생성 비용 한도·X 비용 한도는 반드시 별행 2개(시안의 "API 사용 상한·
 * 켜짐" 1행 통합 표기는 폐기). 통화 포맷은 formatMinorCurrency 재사용(손 문자열
 * 이어붙이기 금지).
 */
interface BudgetRule {
  limit_minor: number;
  currency: GenerationBudgetCurrency;
  period: 'month';
}

interface UtmRules {
  enabled: boolean;
}

interface ContentRules {
  banned_terms: string[];
  require_utm: boolean;
  tone: string | null;
  taxonomy: string[];
  channel_priority: string[];
  brand_kit: { logo_url?: string; colors?: string[]; fonts?: string[] } | null;
  generation_budget: BudgetRule | null;
  api_usage_budget: BudgetRule | null;
  utm_rules: UtmRules | null;
}

function BudgetRow({
  label, budget, t, tContent, locale,
}: {
  label: string;
  budget: BudgetRule | null;
  t: ReturnType<typeof useTranslations<'connectRulesV3'>>;
  // formatMinorCurrency(generation-budget-indicator.tsx)의 CURRENCY_AMOUNT_KEYS는
  // `content` 네임스페이스 키(generationBudgetAmountKrw/Usd)로 고정돼 있다 — 이 화면
  // 전용 t를 넘기면 MISSING_MESSAGE가 난다(재발 방지 — 반드시 `content` 스코프 t만).
  tContent: ReturnType<typeof useTranslations<'content'>>;
  locale: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm" data-testid="connect-rules-v3-budget-row">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">
        {budget
          ? t('ruleLimitSet', {
              amount: formatMinorCurrency(budget.limit_minor, budget.currency, locale, tContent),
              period: t('generationBudgetPeriodMonth'),
            })
          : t('ruleLimitNone')}
      </span>
    </div>
  );
}

export function ConnectRulesV3Rules({ orgId }: { orgId: string }) {
  const t = useTranslations('connectRulesV3');
  const tcr = useTranslations('contentRules');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const [rules, setRules] = useState<ContentRules | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [referenceOpen, setReferenceOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const rulesRes = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
        if (!rulesRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const rulesJson = await rulesRes.json() as { data?: { rules?: ContentRules } };
        if (cancelled) return;
        setRules(rulesJson.data?.rules ?? null);
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, retryKey]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;
  if (!rules) return <ConnectRulesV3SectionEmpty title={t('rulesEmptyTitle')} />;

  const brandKit = rules.brand_kit ?? {};

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div>
          <p className="font-medium text-foreground">{t('ruleBannedTerms')}</p>
          <p className="text-xs text-muted-foreground">{t('ruleBannedTermsDescription')}</p>
        </div>
        <span className="text-xs text-muted-foreground">{rules.banned_terms.length > 0 ? t('ruleOn') : t('ruleOff')}</span>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div>
          <p className="font-medium text-foreground">{t('ruleRequireUtm')}</p>
          <p className="text-xs text-muted-foreground">{t('ruleRequireUtmDescription')}</p>
        </div>
        <span className="text-xs text-muted-foreground">{rules.require_utm ? t('ruleOn') : t('ruleOff')}</span>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm" data-testid="connect-rules-v3-utm-auto-row">
        <div>
          <p className="font-medium text-foreground">{tcr('utmRulesSectionTitle')}</p>
          <p className="text-xs text-muted-foreground">{tcr('utmRulesSectionDescription')}</p>
        </div>
        <span className="text-xs text-muted-foreground">{rules.utm_rules?.enabled ? t('ruleOn') : t('ruleOff')}</span>
      </div>
      <BudgetRow label={t('ruleGenerationBudget')} budget={rules.generation_budget} t={t} tContent={tContent} locale={locale} />
      <BudgetRow label={t('ruleApiUsageBudget')} budget={rules.api_usage_budget} t={t} tContent={tContent} locale={locale} />

      <button
        type="button"
        onClick={() => setReferenceOpen((o) => !o)}
        aria-expanded={referenceOpen}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
        data-testid="connect-rules-v3-reference-toggle"
      >
        {tcr('contentRulesReferenceSectionTitle')}
      </button>
      {referenceOpen ? (
        <div className="space-y-1 rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground" data-testid="connect-rules-v3-reference-body">
          <p>{tcr('toneLabel')}: {rules.tone ?? tcr('contentRulesNotSetLabel')}</p>
          <p>{tcr('taxonomyLabel')}: {rules.taxonomy.length > 0 ? rules.taxonomy.join(', ') : tcr('contentRulesNotSetLabel')}</p>
          <p>{tcr('channelPriorityLabel')}: {rules.channel_priority.length > 0 ? rules.channel_priority.join(', ') : tcr('contentRulesNotSetLabel')}</p>
          <p>
            {tcr('brandKitLabel')}: {
              brandKit.logo_url || (brandKit.colors?.length ?? 0) > 0 || (brandKit.fonts?.length ?? 0) > 0
                ? t('ruleOn')
                : tcr('contentRulesNotSetLabel')
            }
          </p>
        </div>
      ) : null}

      <Link href="/organization/content-rules" className="block text-xs font-medium text-primary hover:underline">
        {t('goToContentRulesLink')}
      </Link>
    </div>
  );
}
