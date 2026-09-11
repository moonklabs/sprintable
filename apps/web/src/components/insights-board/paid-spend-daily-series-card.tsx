'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';

/**
 * story #3809(Phase3·3-7 PR 4b, 페드루 PO 確定 2026-09-11 23:xxZ) — 「고급 보고
 * 첫 출시」 조각4: 일별 paid 지출 시계열 카드(BE PR4a/4b `GET .../insights-board/
 * cost-summary`의 `paid_spend_daily_series` 소비). `OrgCostSummaryCard`(같은
 * 화면 바로 위 카드) 아래에 놓는 별개 카드 — 자체 fetch·자체 로딩/실패 상태
 * (기존 카드들과 동형, 같은 엔드포인트를 두 번 부르는 비용은 이 화면 규모에서
 * 무시 가능한 트레이드오프로 수용).
 *
 * PO 3대 규율(2026-09-11 21:16Z·23:08Z 確定):
 *   ① 「캡처된 날짜만」 점/막대로 — 캡처 안 된 날은 아예 그리지 않는다(0으로
 *      채워 매일 있는 것처럼 보이게 하지 않는다).
 *   ② 라벨에 「캡처 시점 기준」을 항상 명시 — due_at(스케줄 anchor)이 아니라
 *      captured_at 기준임을 숨기지 않는다.
 *   ③ 연속성 주장 0 — 막대/점을 잇는 선을 그리지 않는다(매일 자동 수집을
 *      보장하는 것처럼 보이면 거짓 인상).
 * 통화 안전(PR4b, PR2b와 동형 규율) — 그날 캡처분의 통화가 하나로 안 모이면
 * (BE가 이미 그 날짜 포인트를 `currency`·`spend_minor` 둘 다 null로 냄) 그
 * 날짜는 숫자를 안 그리고 「집계 못 함」 점 표시만 한다(raw 합계·통화 추정 둘 다
 * 금지 — OrgCostSummaryCard의 섞임 규율 그대로).
 */
interface PaidSpendDailyPoint {
  date: string;
  spend_minor: number | null;
  currency: string | null;
  source: 'paid' | 'organic';
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; points: PaidSpendDailyPoint[] };

export function PaidSpendDailySeriesCard({ orgId }: { orgId: string }) {
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
        const json = (await res.json().catch(() => null)) as { data?: { paid_spend_daily_series?: PaidSpendDailyPoint[] } } | null;
        if (!json?.data) {
          setState({ status: 'failed' });
          return;
        }
        setState({ status: 'ok', points: json.data.paid_spend_daily_series ?? [] });
      } catch {
        if (!cancelled) setState({ status: 'failed' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId]);

  if (state.status === 'loading') {
    return (
      <Card className="p-3" data-testid="paid-spend-daily-series-card-loading">
        <div className="h-16 animate-pulse rounded-md bg-muted" />
      </Card>
    );
  }

  if (state.status === 'failed') {
    return (
      <Card className="p-3 text-xs text-muted-foreground" data-testid="paid-spend-daily-series-card-failed">
        {t('paidSpendDailySeriesLoadFailed')}
      </Card>
    );
  }

  const { points } = state;
  // 「막대 높이」는 결측(currency=null) 포인트를 제외한 실 지출값 중 최댓값 기준
  // — null 포인트는 애초 그릴 숫자가 없어 스케일에 참여하지 않는다.
  const maxSpend = Math.max(1, ...points.map((p) => p.spend_minor ?? 0));

  return (
    <Card className="p-3 text-xs" data-testid="paid-spend-daily-series-card">
      <p className="font-medium text-foreground" data-testid="paid-spend-daily-series-title">
        {t('paidSpendDailySeriesTitle')}
      </p>
      <p className="mb-2 text-muted-foreground" data-testid="paid-spend-daily-series-caption">
        {t('paidSpendDailySeriesCaption')}
      </p>

      {points.length === 0 ? (
        <span className="text-muted-foreground" data-testid="paid-spend-daily-series-empty">
          {t('paidSpendDailySeriesEmpty')}
        </span>
      ) : (
        <ul className="flex items-end gap-2" data-testid="paid-spend-daily-series-bars">
          {points.map((point) => {
            const mixed = point.currency === null || point.spend_minor === null;
            const heightPct = mixed ? 0 : Math.max(4, Math.round(((point.spend_minor as number) / maxSpend) * 100));
            const label = mixed
              ? t('paidSpendDailySeriesMixedCurrencyDay')
              : formatMinorCurrency(point.spend_minor as number, point.currency as GenerationBudgetCurrency, locale, tContent);
            return (
              <li
                key={point.date}
                className="flex w-8 flex-col items-center gap-1"
                data-testid="paid-spend-daily-series-point"
                data-date={point.date}
                data-mixed={mixed}
                title={`${point.date} · ${label}`}
              >
                {mixed ? (
                  <span
                    className="h-2 w-2 rounded-full bg-muted-foreground"
                    data-testid="paid-spend-daily-series-point-mixed-dot"
                    aria-label={label}
                  />
                ) : (
                  <div
                    className="w-3 rounded-t-sm bg-foreground"
                    data-testid="paid-spend-daily-series-point-bar"
                    style={{ height: `${heightPct}px` }}
                    aria-label={label}
                  />
                )}
                <span className="text-[10px] text-muted-foreground">{point.date.slice(5)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
