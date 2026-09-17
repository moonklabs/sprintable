'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';

/**
 * story #3982 §(e) 콘텐츠 규칙 — 낱말표 D절 정본: 한도는 켜짐/꺼짐이 아니라 «설정
 * 금액·기간 / 없으면 「없음」»으로 표시하고(GenerationBudgetIndicator의 "정책 없으면
 * 줄 자체를 안 그린다" §19-3 관례는 이 화면엔 안 씀 — 「사라짐 0」이 우선), 생성 비용
 * 한도·X 비용 한도는 반드시 별행 2개(시안의 "API 사용 상한·켜짐" 1행 통합 표기는
 * 폐기). 통화 포맷은 generation-budget-indicator.tsx::formatMinorCurrency 재사용(손
 * 문자열 이어붙이기 금지, PR#4202 addendum 정신 재사용).
 */
interface ContentRules {
  banned_terms: string[];
  require_utm: boolean;
  tone: string | null;
  taxonomy: string[];
  channel_priority: string[];
  brand_kit: { logo_url?: string; colors?: string[]; fonts?: string[] };
}

interface BudgetField {
  limit_minor: number | null;
  currency: GenerationBudgetCurrency | null;
  period: 'month';
}

function BudgetRow({
  label, budget, t, tContent, locale,
}: {
  label: string;
  budget: BudgetField | null;
  t: ReturnType<typeof useTranslations<'connectRulesV3'>>;
  // formatMinorCurrency(generation-budget-indicator.tsx)의 CURRENCY_AMOUNT_KEYS는
  // `content` 네임스페이스 키(generationBudgetAmountKrw/Usd)로 고정돼 있다 — 이 화면
  // 전용 t를 넘기면 MISSING_MESSAGE가 난다(재발 방지 — 반드시 `content` 스코프 t만).
  tContent: ReturnType<typeof useTranslations<'content'>>;
  locale: string;
}) {
  const hasLimit = budget?.limit_minor !== null && budget?.limit_minor !== undefined && budget.currency;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm" data-testid="connect-rules-v3-budget-row">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">
        {hasLimit && budget
          ? t('ruleLimitSet', {
              amount: formatMinorCurrency(budget.limit_minor as number, budget.currency as GenerationBudgetCurrency, locale, tContent),
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
  const [generationBudget, setGenerationBudget] = useState<BudgetField | null>(null);
  const [apiUsageBudget, setApiUsageBudget] = useState<BudgetField | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  const [referenceOpen, setReferenceOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const [rulesRes, genRes, apiRes] = await Promise.all([
          fetchWithAuth(`/api/organizations/${orgId}/content-rules`),
          fetchWithAuth(`/api/organizations/${orgId}/generation-budget`),
          fetchWithAuth(`/api/organizations/${orgId}/api-usage-budget`),
        ]);
        if (!rulesRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const rulesJson = await rulesRes.json() as { data?: { rules?: ContentRules } };
        if (cancelled) return;
        setRules(rulesJson.data?.rules ?? null);
        if (genRes.ok) {
          const genJson = await genRes.json() as { data?: BudgetField };
          if (!cancelled) setGenerationBudget(genJson.data ?? null);
        }
        if (apiRes.ok) {
          const apiJson = await apiRes.json() as { data?: BudgetField };
          if (!cancelled) setApiUsageBudget(apiJson.data ?? null);
        }
        if (!cancelled) setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, retryKey]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;
  if (!rules) return <ConnectRulesV3SectionEmpty title={t('rulesEmptyTitle')} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div>
          <p className="font-medium text-foreground">{t('ruleBannedTerms')}</p>
          <p className="text-xs text-muted-foreground">{t('ruleBannedTermsDescription')}</p>
        </div>
        <Badge variant="secondary">{rules.banned_terms.length}</Badge>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div>
          <p className="font-medium text-foreground">{t('ruleRequireUtm')}</p>
          <p className="text-xs text-muted-foreground">{t('ruleRequireUtmDescription')}</p>
        </div>
        <Badge variant="secondary">{rules.require_utm ? t('ruleOn') : t('ruleOff')}</Badge>
      </div>
      <BudgetRow label={t('ruleGenerationBudget')} budget={generationBudget} t={t} tContent={tContent} locale={locale} />
      <BudgetRow label={t('ruleApiUsageBudget')} budget={apiUsageBudget} t={t} tContent={tContent} locale={locale} />

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
              rules.brand_kit.logo_url || (rules.brand_kit.colors?.length ?? 0) > 0 || (rules.brand_kit.fonts?.length ?? 0) > 0
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
