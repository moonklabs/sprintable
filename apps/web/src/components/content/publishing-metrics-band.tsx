'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';

/**
 * story #3484(BE 3475, 정본 a0da40c9 §18 확定 2026-09-05) — 블루프린트 v3 §7
 * Phase 1 "실측" 열의 화면 몫. 자리는 채널 포스트 목록 헤더 아래 한 줄뿐(캘린더·
 * 연결 화면엔 안 얹는다).
 *
 * §18-1 — 여섯 값은 같은 무게가 아니다: 성능 둘(정시율·복구 p50/p95)은 늘 적고,
 * 사고·행동 넷(중복·승인 없는 호출·만료·7일 내 만료)은 0이 아닐 때만 적는다.
 * 사고 둘(중복·승인 없는 호출)이 «둘 다» 0이면 「중복·승인 없는 호출 0」한 줄로
 * 뭉친다(0을 "이상 없음"으로 접지 않는다 — 무엇을 쟀는지 이름과 함께).
 * 행동 둘(연결)은 그런 뭉침 없이 0이면 아예 안 적는다(§18-3 "링크가 곧 할 일" —
 * 0이면 할 일이 없다).
 *
 * §18-2 — 「0」·「—」·«못 불러옴»은 세 얼굴. on_time_rate/recovery가 null인 것은
 * "분모가 0(이 기간에 관련 활동 자체가 없다)"이지 실패가 아니다 — 이유를 함께 적어
 * "고장인가"로 안 읽히게 한다.
 *
 * §18-5 — 토글은 select가 아니라 size="sm" Button 둘(선택=secondary·나머지
 * ghost), role="group"+aria-label로 묶고 선택에 aria-pressed="true"(하우스
 * 세그먼트 토글 선례 부재 — 이 자리가 선례가 된다).
 *
 * §18-6 — 띠 끝에 computed_at(§11-2 정본 포맷) — Date.now()로 지어내지 않는다.
 */
interface PublishingMetrics {
  window: '7d' | '30d';
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

// PO 보정(2026-09-05, PR#3833 리뷰) — 「—」만 서면 이유 없이 "고장인가"로 읽힌다
// (§18-2). recovery null의 뜻은 정시율과 다르다 — "이 기간에 실패가 없어 복구할
// 것 자체가 없었다"이므로 별도 문구를 쓴다(정시율의 "발행이 없다"와 혼동 금지).
function formatRecoveryMinutes(seconds: number | null, t: Translator): string {
  if (seconds === null) return `${t('publishingMetricsUnmeasuredDash')} (${t('publishingMetricsRecoveryNoFailures')})`;
  return t('publishingMetricsMinutesUnit', { minutes: Math.round(seconds / 60) });
}

export function PublishingMetricsBand({ orgId }: { orgId: string }) {
  const t = useTranslations('content');
  const [window_, setWindow] = useState<'7d' | '30d'>('7d');
  const [metrics, setMetrics] = useState<PublishingMetrics | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // react-hooks/set-state-in-effect — window 토글은 상태→effect→상태 사슬이
  // 아니라 클릭이 직접 이 함수를 부른다(파라미터로 window를 받는다, 클로저에
  // 갇힌 state를 안 본다). 마운트 시 1회만 effect가 기본값(7d)으로 부른다.
  const load = useCallback(async (win: '7d' | '30d') => {
    if (!orgId) return;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/publishing-metrics?window=${win}`);
      if (!res.ok) {
        setLoadFailed(true);
        setMetrics(null);
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: PublishingMetrics } | null;
      setLoadFailed(false);
      setMetrics(json?.data ?? null);
    } catch {
      setLoadFailed(true);
      setMetrics(null);
    }
  }, [orgId]);

  useEffect(() => {
    // 마운트 시 기본 window(7d)로 최초 조회. load 내부 setState는 항상 첫
    // await 뒤(위 주석) — 이 규칙은 dep 배열의 함수 호출 자체를 정적으로
    // 막아 그 구분을 못 본다(organization/roles/page.tsx와 동일 관례).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load('7d');
  }, [load]);

  const handleWindowChange = (win: '7d' | '30d') => {
    setWindow(win);
    void load(win);
  };

  const accidentBothZero = metrics ? metrics.duplicate_publications === 0 && metrics.unapproved_adapter_calls === 0 : false;
  const displayTimezone = resolveDisplayTimezone().tz;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/20 p-3 text-xs text-foreground"
      data-testid="publishing-metrics-band"
    >
      <div className="flex gap-1" role="group" aria-label={t('publishingMetricsWindowGroupLabel')}>
        <Button
          type="button" size="sm" variant={window_ === '7d' ? 'secondary' : 'ghost'}
          aria-pressed={window_ === '7d'}
          onClick={() => handleWindowChange('7d')} data-testid="publishing-metrics-window-7d"
        >
          {t('publishingMetricsWindow7d')}
        </Button>
        <Button
          type="button" size="sm" variant={window_ === '30d' ? 'secondary' : 'ghost'}
          aria-pressed={window_ === '30d'}
          onClick={() => handleWindowChange('30d')} data-testid="publishing-metrics-window-30d"
        >
          {t('publishingMetricsWindow30d')}
        </Button>
      </div>
      {loadFailed ? (
        <span className="text-muted-foreground" data-testid="publishing-metrics-load-failed">
          {t('publishingMetricsLoadFailed')}
        </span>
      ) : metrics ? (
        <>
          <span data-testid="publishing-metrics-on-time-rate">
            {t('publishingMetricsOnTimeRateLabel')} {formatOnTimeRate(metrics.on_time_rate, t)}
          </span>
          <span data-testid="publishing-metrics-recovery">
            {t('publishingMetricsRecoveryLabel')} p50 {formatRecoveryMinutes(metrics.recovery_seconds_p50, t)} / p95 {formatRecoveryMinutes(metrics.recovery_seconds_p95, t)}
          </span>
          {/* §18-1 — 사고 둘이 다 0이면 뭉쳐서 한 줄, 아니면 0이 아닌 것만 개별로. */}
          {accidentBothZero ? (
            <span data-testid="publishing-metrics-accident-zero">{t('publishingMetricsAccidentZero')}</span>
          ) : (
            <>
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
            </>
          )}
          {/* §18-3 — 링크가 곧 할 일. 0이면 안 적는다(뭉침 없음 — 행동 항목은 할
              일이 없으면 언급 자체가 없다). */}
          {metrics.connections_expired > 0 ? (
            <span data-testid="publishing-metrics-connections-expired">
              <Link href="/organization/channels" className="underline" data-testid="publishing-metrics-connections-expired-link">
                {t('publishingMetricsConnectionsExpiredNonzero', { count: metrics.connections_expired })}
              </Link>
            </span>
          ) : null}
          {metrics.connections_expiring_7d > 0 ? (
            <span data-testid="publishing-metrics-connections-expiring">
              <Link href="/organization/channels" className="underline" data-testid="publishing-metrics-connections-expiring-link">
                {t('publishingMetricsConnectionsExpiringNonzero', { count: metrics.connections_expiring_7d })}
              </Link>
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
  );
}
