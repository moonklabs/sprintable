'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { fetchWithAuth } from '@/lib/db/client';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

/**
 * story #3484(BE 3475, 정본 a0da40c9 §18 확定 2026-09-05) — 블루프린트 v3 §7
 * Phase 1 "실측" 열의 화면 몫.
 *
 * story #3746(2026-09-09) — 채널 포스트 목록(content/channel-posts/page.tsx)에서
 * 성과 보드(organization/insights-board/page.tsx) 표 아래로 이주. 한 손 이동:
 *   ① «연결 건강»(만료 연결·7일 내 만료) 은퇴 — ③(3743)의 행 칩+cron 알림이 그
 *      필요를 이미 채운다. 지금부터 이 띠는 «발행 품질» 셋만(정시율·중복·승인 없는
 *      호출).
 *   ② 띠 자체 기간 토글(로컬 state)을 걷는다 — 화면(성과 보드)이 이미 URL 구동
 *      기간 컨트롤(7d/30d/90d)을 갖고 있어 그걸 그대로 따른다(`window` prop). 같은
 *      기간 개념을 두 곳에서 따로 관리하지 않는다.
 *   ③ BE가 이제 90d도 받는다(publishing_metrics.py — 라우터 검증 3값+서비스 삼항
 *      →3분기).
 *
 * §18-1(여전히 유효) — 정시율은 늘 적고, 사고 둘(중복·승인 없는 호출)은 0이 아닐
 * 때만 적는다(0을 "이상 없음"으로 접지 않는다 — story #3735가 걷은 "0/0 요약 줄"
 * 규율 그대로 유지, 이 스토리는 그 규율을 안 건드린다).
 * §18-2 — 「0」·「—」·«못 불러옴»은 세 얼굴. on_time_rate가 null인 것은 "분모가
 * 0(이 기간에 관련 활동 자체가 없다)"이지 실패가 아니다.
 * §18-6 — 띠 끝에 computed_at(§11-2 정본 포맷) — Date.now()로 지어내지 않는다.
 */
export type PublishingMetricsWindow = '7d' | '30d' | '90d';

interface PublishingMetrics {
  window: PublishingMetricsWindow;
  on_time_rate: number | null;
  on_time_numer: number;
  on_time_denom: number;
  duplicate_publications: number;
  unapproved_adapter_calls: number;
  recovery_seconds_p50: number | null;
  recovery_seconds_p95: number | null;
  connections_expired: number;
  connections_expiring_7d: number;
  computed_at: string | null;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

// §18-2 — null="분모 0"(활동 없음), 값 있으면 그대로 백분율.
function formatOnTimeRate(rate: number | null, t: Translator): string {
  if (rate === null) return `${t('publishingMetricsUnmeasuredDash')} (${t('publishingMetricsUnmeasuredReason')})`;
  return `${Math.round(rate * 100)}%`;
}

export function PublishingMetricsBand({ orgId, window: win }: { orgId: string; window: PublishingMetricsWindow }) {
  const t = useTranslations('content');
  const [metrics, setMetrics] = useState<PublishingMetrics | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/publishing-metrics?window=${win}`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadFailed(true);
          setMetrics(null);
          return;
        }
        const json = (await res.json().catch(() => null)) as { data?: PublishingMetrics } | null;
        setLoadFailed(false);
        setMetrics(json?.data ?? null);
      } catch {
        if (!cancelled) {
          setLoadFailed(true);
          setMetrics(null);
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId, win]);

  const displayTimezone = resolveDisplayTimezone().tz;

  return (
    <div
      className="rounded-md border border-border bg-muted/20 p-3 text-xs text-foreground"
      data-testid="publishing-metrics-band"
    >
      {/* PO CHANGES⑦(2026-09-09) — 표 바로 아래라 구획 경계는 최소한(별도 카드 톤
          없이 작은 라벨 한 줄). 기간(「지난 N일 — 화면 기간을 따릅니다」류)은 안
          그린다 — 이 화면 자체의 기간 컨트롤이 이미 있어 중복이다. */}
      <p className="mb-1.5 font-medium text-foreground" data-testid="publishing-metrics-title">
        {t('publishingMetricsTitle')}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {loadFailed ? (
          <span className="text-muted-foreground" data-testid="publishing-metrics-load-failed">
            {t('publishingMetricsLoadFailed')}
          </span>
        ) : metrics ? (
          <>
            <span data-testid="publishing-metrics-on-time-rate">
              {t('publishingMetricsOnTimeRateLabel')} {formatOnTimeRate(metrics.on_time_rate, t)}
            </span>
            {/* story #3735(B1·B2, 유나 定 2026-09-09) — 복구 p50/p95(엔지니어 지표)·
                사고 둘 다 0일 때의 「중복·승인 없는 호출 0」 요약 줄을 걷었다. 0이면
                아예 안 적는다는 §18-1/§18-3의 "행동" 규율을 "사고"에도 그대로
                맞춘다(0을 굳이 「이상 없음」으로 적지 않는다). */}
            {metrics.duplicate_publications > 0 ? (
              <span data-testid="publishing-metrics-duplicate">
                {t('publishingMetricsDuplicateNonzero', { count: metrics.duplicate_publications })}
              </span>
            ) : null}
            {metrics.unapproved_adapter_calls > 0 ? (
              <span data-testid="publishing-metrics-unapproved">
                {t('publishingMetricsUnapprovedNonzero', { count: metrics.unapproved_adapter_calls })}
              </span>
            ) : null}
            {metrics.computed_at ? (
              <span className="ml-auto text-muted-foreground" data-testid="publishing-metrics-computed-at">
                {t('publishingMetricsComputedAt', { time: formatScheduledAt(metrics.computed_at, displayTimezone).display })}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
