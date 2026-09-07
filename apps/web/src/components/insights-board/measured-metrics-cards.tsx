'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3618(BE+FE·실측, 페드루 PO 確定 2026-09-07) — 블루프린트 §7 Phase 2 실측 열
 * 3종(UTM 귀속률·댓글 누락률·후속 작업 생성률)을 성과 보드 상단 카드로 보여준다.
 * BE `GET .../insights/measured-metrics?days=7|30` 계약 그대로 — 「0」과 「—」(미측정)
 * 을 명확히 구분한다(AC2 명시: value가 null이면 「—」+사유 한 줄, 0이면 "0%"를 그대로
 * 보여 "측정은 됐고 실제로 0"임을 안다).
 *
 * 페드루 PO CHANGES(2026-09-07, 유나 낱말 판정) — 이름에서 "Phase 2"(블루프린트 내부
 * 단계명, 단계가 끝나면 이름이 거짓이 되는 클래스)를 뗐다: 파일명·컴포넌트명·타입명·
 * BE 모듈·엔드포인트 경로 전부 measured-*로. 「—」 표시는 새 낱말을 안 만들고 이 화면이
 * 이미 쓰던 `content` 네임스페이스의 `insightMetricUnavailableDash`를 그대로 재사용
 * (insights-board-metric-cell.tsx와 동일 관례) — 사유 줄만 이 스토리 전용.
 *
 * 페드루 PO CHANGES 2(2026-09-07, 유나 자리축) — 이 카드가 자체 7/30 토글을 갖고
 * 있었는데, 같은 화면 상단에 이미 페이지 전체 「기간」 선택(7/30/90d·URL `?window=`)
 * 이 있어 기간 조작이 둘이었다. 처방(PO 채택): 카드 자체 토글을 없애고 `windowDays`
 * prop으로 페이지 window를 그대로 따른다 — 기간 조작은 화면에 하나. BE는 7/30만
 * 받는 계약(days 파라미터 자체를 안 바꿈) — 90일 선택 시 이 컴포넌트는 BE를 아예
 * 안 부르고(조용히 30일로 떨어뜨리지 않는다) 3장 다 「—」+`WINDOW_UNSUPPORTED` 사유로
 * 렌더한다(기존 미측정 표시 관례 그대로 재사용, 새 UI 분기 0).
 */

type MeasuredMetricValue = {
  value: number | null;
  numerator: number;
  denominator: number;
  reason_code: string | null;
};

type MeasuredMetricsResponse = {
  utm_attribution_rate: MeasuredMetricValue;
  comment_miss_rate: MeasuredMetricValue;
  follow_up_creation_rate: MeasuredMetricValue;
  computed_at: string;
};

const REASON_LABEL_KEYS: Record<string, string> = {
  NO_PAGEVIEWS: 'measuredReasonNoPageviews',
  NO_COMMENT_DATA: 'measuredReasonNoCommentData',
  NO_SNAPSHOTS: 'measuredReasonNoSnapshots',
  WINDOW_UNSUPPORTED: 'measuredReasonWindowUnsupported',
};

const _UNMEASURED_METRIC: MeasuredMetricValue = { value: null, numerator: 0, denominator: 0, reason_code: 'WINDOW_UNSUPPORTED' };
// 90일(BE 미지원 기간) 전용 — 3장 다 같은 사유로 「—」. 네트워크 호출 자체를 안 한다.
const WINDOW_UNSUPPORTED_RESPONSE: MeasuredMetricsResponse = {
  utm_attribution_rate: _UNMEASURED_METRIC,
  comment_miss_rate: _UNMEASURED_METRIC,
  follow_up_creation_rate: _UNMEASURED_METRIC,
  computed_at: '',
};

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function MetricCard({
  label, metric, t, tContent,
}: {
  label: string;
  metric: MeasuredMetricValue | undefined;
  t: ReturnType<typeof useTranslations>;
  tContent: ReturnType<typeof useTranslations>;
}) {
  if (!metric || metric.value === null) {
    const reasonKey = metric?.reason_code ? REASON_LABEL_KEYS[metric.reason_code] : undefined;
    return (
      <div className="rounded-lg border border-border bg-card p-3" data-testid="measured-metric-card">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold text-muted-foreground" data-testid="measured-metric-value">
          {tContent('insightMetricUnavailableDash')}
        </p>
        {reasonKey && <p className="mt-0.5 text-[11px] text-muted-foreground">{t(reasonKey)}</p>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid="measured-metric-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground" data-testid="measured-metric-value">
        {formatPercent(metric.value)}
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{metric.numerator} / {metric.denominator}</p>
    </div>
  );
}

export function MeasuredMetricsCards({ orgId, windowDays }: { orgId: string; windowDays: 7 | 30 | 90 }) {
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const [data, setData] = useState<MeasuredMetricsResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (windowDays === 90) {
      setLoading(false);
      setError(false);
      setData(WINDOW_UNSUPPORTED_RESPONSE);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const res = await fetchWithAuth(
          `/api/organizations/${orgId}/insights/measured-metrics?days=${windowDays}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const body = await res.json() as { data?: MeasuredMetricsResponse };
        if (cancelled) return;
        if (!body.data) {
          setError(true);
          return;
        }
        setData(body.data);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, windowDays]);

  return (
    <div className="space-y-2" data-testid="measured-metrics-section">
      <p className="text-xs font-medium text-muted-foreground">{t('measuredMetricsTitle')}</p>
      {loading && !data && (
        <div className="grid grid-cols-3 gap-2" data-testid="measured-metrics-loading">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />)}
        </div>
      )}
      {error && !loading && (
        <p className="text-xs text-destructive" data-testid="measured-metrics-error">{t('measuredMetricsErrorGeneric')}</p>
      )}
      {data && (
        <div className="grid grid-cols-3 gap-2">
          <MetricCard label={t('measuredAttributionRate')} metric={data.utm_attribution_rate} t={t} tContent={tContent} />
          <MetricCard label={t('measuredCommentMissRate')} metric={data.comment_miss_rate} t={t} tContent={tContent} />
          <MetricCard label={t('measuredFollowUpRate')} metric={data.follow_up_creation_rate} t={t} tContent={tContent} />
        </div>
      )}
    </div>
  );
}
