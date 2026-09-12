'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';

/**
 * story #3809(Phase3·3-7 PR 3, 페드루 PO 確定 2026-09-11 19:00Z) — 「고급 보고
 * 첫 출시」 조각3: 조직 단위 비용 원장 카드(BE PR1+PR2b `GET .../insights-board/
 * cost-summary` 소비). `PublishingMetricsBand`(같은 화면 하단 밴드)와 동형 —
 * 자체 fetch·자체 로딩/실패 상태, 화면의 window/channel/status 필터와 무관
 * (org 전체 스코프, 쿼리 파라미터 0).
 *
 * 통화 안전 계약(PR2b 정본, PO 지침②/③ 재확認) — **FE는 통화를 절대 추정하지
 * 않는다**:
 *   ① `approved_boost_count === 0` — 「더할 게 없다」는 정직한 사실(합계는 실제
 *      0, `sealed_ads_currency`가 null인 것도 정상). 「승인된 홍보가 없다」는
 *      문장만 보인다.
 *   ② `sealed_ads_currency !== null`(0건 아닌데 통화가 하나로 모임) — 그 통화로
 *      `formatMinorCurrency` 재사용해 실제 합계를 그린다.
 *   ③ `sealed_ads_currency === null`(0건 아닌데 통화가 섞임, PR2b) — 세 합계
 *      필드가 전부 null이라 숫자를 그릴 수 없다 — 안전 문구만("통화가 섞여
 *      합계를 표시하지 않습니다"), 원 raw 숫자·"KRW로 가정" 둘 다 금지.
 * `generation_currency`도 같은 규율(PR#3848 PO 지침②) — 지출값은 있는데 통화가
 * 없으면(서버 응답 불완전) `GenerationBudgetIndicator`의 failed 갈래와 동형으로
 * 접는다(추정 채움 금지).
 */
interface OrgAdsCostSummary {
  approved_boost_count: number;
  sealed_ads_currency: string | null;
  sealed_budget_minor: number | null;
  captured_spend_minor: number | null;
  remaining_minor: number | null;
  cap_reached_count: number;
}

interface OrgCostSummary {
  ads: OrgAdsCostSummary;
  generation_cost_spent_minor: number | null;
  generation_cost_period_start: string | null;
  generation_cost_period_end: string | null;
  generation_currency: string | null;
  x_cost_spent_minor: number | null;
  x_cost_period_start: string | null;
  x_cost_period_end: string | null;
  x_currency: string | null;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; summary: OrgCostSummary };

export function OrgCostSummaryCard({ orgId }: { orgId: string }) {
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/insights-board/cost-summary`);
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: 'failed' });
          return;
        }
        const json = (await res.json().catch(() => null)) as { data?: OrgCostSummary } | null;
        if (!json?.data) {
          setState({ status: 'failed' });
          return;
        }
        setState({ status: 'ok', summary: json.data });
      } catch {
        if (!cancelled) setState({ status: 'failed' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId]);

  if (state.status === 'loading') {
    return (
      <Card className="p-3" data-testid="org-cost-summary-card-loading">
        <div className="h-12 animate-pulse rounded-md bg-muted" />
      </Card>
    );
  }

  if (state.status === 'failed') {
    return (
      <Card className="p-3 text-xs text-muted-foreground" data-testid="org-cost-summary-card-failed">
        {t('orgCostLoadFailed')}
      </Card>
    );
  }

  const { ads, generation_cost_spent_minor, generation_currency, x_cost_spent_minor, x_currency } = state.summary;
  const adsCurrency = ads.sealed_ads_currency as GenerationBudgetCurrency | null;
  // ①0건과 ③섞임은 둘 다 sealed_ads_currency===null이지만 뜻이 다르다 —
  // approved_boost_count로 갈라야 「0건」을 「섞였다」로 잘못 읽지 않는다.
  const adsCurrencyMixed = ads.approved_boost_count > 0 && adsCurrency === null;

  return (
    <Card className="p-3 text-xs" data-testid="org-cost-summary-card">
      <p className="mb-2 font-medium text-foreground" data-testid="org-cost-summary-title">
        {t('orgCostSummaryTitle')}
      </p>

      <div className="space-y-1.5">
        <div data-testid="org-cost-ads-section">
          {ads.approved_boost_count === 0 ? (
            <span className="text-muted-foreground" data-testid="org-cost-ads-none">
              {t('orgCostAdsNoApprovedBoosts')}
            </span>
          ) : (
            <div className="space-y-1">
              <span data-testid="org-cost-ads-approved-count">
                {t('orgCostAdsApprovedCount', { count: ads.approved_boost_count })}
              </span>
              {adsCurrencyMixed ? (
                <p className="text-muted-foreground" data-testid="org-cost-ads-currency-mixed">
                  {t('orgCostAdsCurrencyMixed')}
                </p>
              ) : adsCurrency && ads.sealed_budget_minor !== null && ads.captured_spend_minor !== null && ads.remaining_minor !== null ? (
                <p className="text-foreground" data-testid="org-cost-ads-amounts">
                  {t('orgCostAdsBudgetSpentRemaining', {
                    budget: formatMinorCurrency(ads.sealed_budget_minor, adsCurrency, locale, tContent),
                    spent: formatMinorCurrency(ads.captured_spend_minor, adsCurrency, locale, tContent),
                    remaining: formatMinorCurrency(ads.remaining_minor, adsCurrency, locale, tContent),
                  })}
                </p>
              ) : null}
              {ads.cap_reached_count > 0 ? (
                <p className="text-muted-foreground" data-testid="org-cost-ads-cap-reached">
                  {t('orgCostAdsCapReachedNonzero', { count: ads.cap_reached_count })}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* story #3809(Phase3·3-7 PR 3, 페드루 PO 라이브 캡처 정정 2026-09-11 20:57Z
            +유나 코드 선판정 정정 2026-09-11 21:00Z) — 원장이 3축(광고비·생성
            비용·X 비용)인데 X축은 null이어도 「아직 측정되지 않습니다」 줄이
            항상 있고, 이 축만 null일 때 줄 자체가 사라졌었다 — 한 축은 "없음"을
            말하고 한 축은 침묵하면 0/미측정을 못 가른다. `compute_generation_
            budget_status`(BE) 확認: null=정책(예산 한도) 자체가 없다(X와 동형
            "이 축을 아직 안 잰다") — X와 같은 결로 "아직 측정되지 않습니다".
            정책이 있으면 spent_minor는 0이든 양수든 항상 실수(real int)라 그냥
            formatMinorCurrency로 그린다(0원도 지어낸 문장 없이 그대로 — 0을
            특별취급해 새 문장을 짓는 게 오히려 과잉, 유나 지적). */}
        <div data-testid="org-cost-generation-section">
          {generation_cost_spent_minor === null ? (
            <span className="text-muted-foreground" data-testid="org-cost-generation-unmeasured">
              {t('orgCostGenerationUnmeasured')}
            </span>
          ) : generation_currency === null ? (
            // PR#3848 PO 지침②(§19-1 재확認 규율) — 지출값은 있는데 통화가
            // 없으면(서버 응답 불완전) 통화를 추정해 채우지 않는다. 실제 BE
            // 계약상 이 조합은 발생하지 않지만(정책 있으면 currency 항상
            // 채워짐) 방어적으로 유지.
            <span className="text-muted-foreground" data-testid="org-cost-generation-failed">
              {t('orgCostGenerationCheckFailed')}
            </span>
          ) : (
            <span data-testid="org-cost-generation-amount">
              {t('orgCostGenerationSpent', {
                amount: formatMinorCurrency(generation_cost_spent_minor, generation_currency as GenerationBudgetCurrency, locale, tContent),
              })}
            </span>
          )}
        </div>

        {/* story #3808(PR5c, 페드루 PO 確定 2026-09-12 — 라이브 회차 결함 처방) —
            x_cost_spent_minor가 항상 null이던 시절엔 이 자리가 "미측정" 한 갈래뿐
            이었다. BE가 api_usage_budget 지갑에서 실값을 채우기 시작하면서 generation
            섹션과 동형 3분기(미측정/통화 실패/실값)가 필요해졌다 — 그 전엔 non-null
            분기 자체가 없어 실 지출이 있어도 화면에 아무것도 안 그려졌다(침묵 결함). */}
        {x_cost_spent_minor === null ? (
          <span className="text-muted-foreground" data-testid="org-cost-x-cost-unmeasured">
            {t('orgCostXCostUnmeasured')}
          </span>
        ) : x_currency === null ? (
          <span className="text-muted-foreground" data-testid="org-cost-x-cost-failed">
            {t('orgCostXCostCheckFailed')}
          </span>
        ) : (
          <span data-testid="org-cost-x-cost-amount">
            {t('orgCostXCostSpent', {
              amount: formatMinorCurrency(x_cost_spent_minor, x_currency as GenerationBudgetCurrency, locale, tContent),
            })}
          </span>
        )}
      </div>
    </Card>
  );
}
