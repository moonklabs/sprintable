'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3618(Phase2·BE+FE·실측, 페드루 PO 確定 2026-09-07) — 블루프린트 §7 Phase 2
 * 실측 열 3종(UTM 귀속률·댓글 누락률·후속 작업 생성률)을 성과 보드 상단 카드로
 * 보여준다. BE `GET .../insights/phase2-metrics?days=7|30` 계약 그대로 — 「0」과
 * 「—」(미측정)을 명확히 구분한다(AC2 명시: value가 null이면 「—」+사유 한 줄, 0이면
 * "0%"를 그대로 보여 "측정은 됐고 실제로 0"임을 안다).
 */

type Phase2MetricValue = {
  value: number | null;
  numerator: number;
  denominator: number;
  reason_code: string | null;
};

type Phase2MetricsResponse = {
  utm_attribution_rate: Phase2MetricValue;
  comment_miss_rate: Phase2MetricValue;
  follow_up_creation_rate: Phase2MetricValue;
  computed_at: string;
};

const REASON_LABEL_KEYS: Record<string, string> = {
  NO_PAGEVIEWS: 'phase2ReasonNoPageviews',
  NO_COMMENT_DATA: 'phase2ReasonNoCommentData',
  NO_SNAPSHOTS: 'phase2ReasonNoSnapshots',
};

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function MetricCard({
  label, metric, t,
}: {
  label: string;
  metric: Phase2MetricValue | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  if (!metric || metric.value === null) {
    const reasonKey = metric?.reason_code ? REASON_LABEL_KEYS[metric.reason_code] : undefined;
    return (
      <div className="rounded-lg border border-border bg-card p-3" data-testid="phase2-metric-card">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold text-muted-foreground" data-testid="phase2-metric-value">
          {t('phase2Unmeasured')}
        </p>
        {reasonKey && <p className="mt-0.5 text-[11px] text-muted-foreground">{t(reasonKey)}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid="phase2-metric-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground" data-testid="phase2-metric-value">
        {formatPercent(metric.value)}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.numerator} / {metric.denominator}</p>
    </div>
  );
}

export function Phase2MetricsCards({ orgId }: { orgId: string }) {
  const t = useTranslations('insightsBoard');
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<Phase2MetricsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (windowDays: 7 | 30) => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth(
        `/api/organizations/${orgId}/insights/phase2-metrics?days=${windowDays}`,
      );
      if (!res.ok) {
        setError(true);
        return;
      }
      const body = await res.json() as { data?: Phase2MetricsResponse };
      if (!body.data) {
        setError(true);
        return;
      }
      setData(body.data);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load(days);
  }, [load, days]);

  return (
    <div className="space-y-2" data-testid="phase2-metrics-section">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{t('phase2MetricsTitle')}</p>
        <div className="flex gap-1">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              data-testid={`phase2-days-${d}`}
              aria-pressed={days === d}
              className={`rounded-[0.4rem] border px-2 py-0.5 text-[11px] ${
                days === d
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-card text-muted-foreground'
              }`}
            >
              {d === 7 ? t('window7d') : t('window30d')}
            </button>
          ))}
        </div>
      </div>
      {loading && !data && (
        <div className="grid grid-cols-3 gap-2" data-testid="phase2-metrics-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />)}
        </div>
      )}
      {error && !loading && (
        <p className="text-xs text-destructive" data-testid="phase2-metrics-error">{t('phase2MetricsErrorGeneric')}</p>
      )}
      {data && (
        <div className="grid grid-cols-3 gap-2">
          <MetricCard label={t('phase2AttributionRate')} metric={data.utm_attribution_rate} t={t} />
          <MetricCard label={t('phase2CommentMissRate')} metric={data.comment_miss_rate} t={t} />
          <MetricCard label={t('phase2FollowUpRate')} metric={data.follow_up_creation_rate} t={t} />
        </div>
      )}
    </div>
  );
}
