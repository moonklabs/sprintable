'use client';

import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';
import { formatScheduledAt } from '@/components/content/schedule-format';

// story #3499(Phase2·FE, 게시물 성과 표면 1차) — BE #3497/PR#3844 계약(PO 確定
// 2026-09-05) 그대로: normalized 7키(impressions/reach/views/engagements/clicks/
// spend/conversions)는 number | null — null=이 채널이 이 지표를 안 준다, 0=실측
// 0(둘을 같은 얼굴로 그리면 3497의 척추가 무너진다, 스토리 본문 원문).
export interface InsightNormalizedMetrics {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  engagements: number | null;
  clicks: number | null;
  spend: number | null;
  conversions: number | null;
}

export type InsightSnapshotStatus = 'pending' | 'captured' | 'unsupported' | 'failed' | 'dead_letter';

export interface InsightSnapshot {
  normalized: InsightNormalizedMetrics;
  captured_at: string | null;
  status: InsightSnapshotStatus;
  due_at: string | null;
  source: string;
}

export interface InsightSnapshotBlockProps {
  snapshots: InsightSnapshot[];
  orgTimezone: string;
  locale: string;
}

const METRIC_KEYS = ['impressions', 'reach', 'views', 'engagements', 'clicks', 'spend', 'conversions'] as const;

const METRIC_LABEL_KEYS: Record<(typeof METRIC_KEYS)[number], string> = {
  impressions: 'insightMetricImpressions',
  reach: 'insightMetricReach',
  views: 'insightMetricViews',
  engagements: 'insightMetricEngagements',
  clicks: 'insightMetricClicks',
  spend: 'insightMetricSpend',
  conversions: 'insightMetricConversions',
};

// doc a0da40c9 §17-19(유나 2026-09-05, 이 스토리를 위한 확장 + PR#3846 실측 보강) —
// captured/unsupported 값+라벨 신규, pending/failed/dead_letter는 §17-10 기존 두
// enum 라벨 재사용(같은 사실을 두 벌로 안 쓴다). captured는 «비배지 원칙»(유나
// 지적) — 값이 있으면 값만 보이고 라벨은 안 그린다, 이 맵은 pending/failed/
// dead_letter 자리에만 실제로 쓰인다(captured는 아래 렌더 로직에서 애초에 이
// 맵을 안 거친다). unsupported는 이 맵에 없다 — §17-19 보강절이 "배지 라벨을
// 쓰는 자리가 없으면 그 키는 죽은 키다"로 직접 지적한 자리(문장 분기가 먼저
// 잡아 폴백까지 안 내려간다, 아래 `insightSnapshotUnsupported` 참조) — 지웠다.
const STATUS_LABEL_KEYS: Partial<Record<InsightSnapshotStatus, string>> = {
  pending: 'insightStatusPending',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  dead_letter: 'insightStatusDeadLetter',
};

// §17-18(doc a0da40c9) 톤 축 — "나쁜 소식인가"만 색을 가른다. failed·dead_letter만
// destructive(FailureActionBadge와 동일 관례, failure-action-badge.tsx 참조) — 나머지
// (pending·captured·unsupported)는 중립(유나: "unsupported는 실패가 아니라 성질,
// 경고색을 쓰면 고칠 것이 없는데 고치러 가게 된다").
const DESTRUCTIVE_STATUSES: ReadonlySet<InsightSnapshotStatus> = new Set(['failed', 'dead_letter']);

function findLatestCaptured(snapshots: InsightSnapshot[]): InsightSnapshot | null {
  let latest: InsightSnapshot | null = null;
  for (const snap of snapshots) {
    if (snap.status !== 'captured' || !snap.captured_at) continue;
    if (!latest || !latest.captured_at || snap.captured_at > latest.captured_at) latest = snap;
  }
  return latest;
}

function MetricValue({ value, dashLabel, reasonLabel }: { value: number | null; dashLabel: string; reasonLabel: string }) {
  // null↔0 구분 — 3497의 척추(스토리 본문). 0은 실측값이라 그대로 보이고, null만
  // 대시+사유 두 키로 갈라 보인다(§18-2 형 그대로, publishingMetricsUnmeasured*
  // 선례와 동형 — 대시와 사유를 한 문자열로 합치지 않는다).
  if (value === null) {
    return (
      <span>
        <span data-testid="insight-metric-dash">{dashLabel}</span>
        <span className="ml-1 text-xs text-muted-foreground" data-testid="insight-metric-reason">{reasonLabel}</span>
      </span>
    );
  }
  return <span data-testid="insight-metric-value">{value}</span>;
}

export function InsightSnapshotBlock({ snapshots, orgTimezone, locale }: InsightSnapshotBlockProps) {
  const t = useTranslations('content');

  if (snapshots.length === 0) return null;

  const latest = findLatestCaptured(snapshots);

  return (
    <div
      data-testid="content-insight-info"
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
    >
      <p className="text-xs font-medium text-muted-foreground">{t('insightSectionLabel')}</p>

      {latest ? (
        // 유나 지적(§17-19) — captured는 값이 있으면 값만 그린다, "수집됨" 배지를
        // 옆에 안 세운다(값 자체가 이미 "수집됐다"는 신호다, §18-1 "0이면 아예
        // 안 적는다"의 반대 방향 적용).
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3" data-testid="insight-latest-row">
          {METRIC_KEYS.map((key) => (
            <div key={key}>
              <dt className="text-xs text-muted-foreground">{t(METRIC_LABEL_KEYS[key])}</dt>
              <dd>
                <MetricValue
                  value={latest.normalized[key]}
                  dashLabel={t('insightMetricUnavailableDash')}
                  reasonLabel={t('insightMetricUnavailableReason')}
                />
              </dd>
            </div>
          ))}
          <div className="col-span-full text-xs text-muted-foreground">
            {t('insightCapturedAtLabel')} {formatRelativeTime(latest.captured_at as string, locale, orgTimezone)}
            {' · '}
            {latest.source}
          </div>
        </dl>
      ) : null}

      <ul className="space-y-2" data-testid="insight-snapshot-list">
        {snapshots.map((snap, idx) => {
          const dueDisplay = snap.due_at ? formatScheduledAt(snap.due_at, orgTimezone).display : null;
          const toneClass = DESTRUCTIVE_STATUSES.has(snap.status) ? 'text-destructive' : 'text-muted-foreground';
          return (
            <li key={`${snap.source}-${snap.due_at ?? idx}`} className="text-xs" data-testid="insight-snapshot-row">
              {snap.status === 'pending' && !snap.captured_at ? (
                <span className={toneClass} data-testid="insight-snapshot-pending">
                  {dueDisplay ? t('insightSnapshotPendingWithDue', { due: dueDisplay }) : t(STATUS_LABEL_KEYS.pending!)}
                </span>
              ) : snap.status === 'unsupported' ? (
                <span className={toneClass} data-testid="insight-snapshot-unsupported">
                  {t('insightSnapshotUnsupported')}
                </span>
              ) : snap.status === 'failed' || snap.status === 'dead_letter' ? (
                <span className={toneClass} data-testid="insight-snapshot-failure">
                  {/* failed/dead_letter는 STATUS_LABEL_KEYS에 항상 존재 — unsupported만 없음(위에서 처리 済) */}
                  {t(STATUS_LABEL_KEYS[snap.status]!)}
                </span>
              ) : snap.status === 'captured' && snap.captured_at ? (
                <span data-testid="insight-snapshot-captured">
                  {formatRelativeTime(snap.captured_at, locale, orgTimezone)}
                  {dueDisplay ? ` · ${dueDisplay}` : ''}
                </span>
              ) : (
                // 여기 도달하는 유일한 경우는 status==='captured'인데 captured_at이 null인
                // 방어적 엣지케이스(계약상 있어선 안 되지만 렌더가 죽지 않게) — unsupported는
                // 위 분기가 이미 잡아 여기 안 옴.
                <span className={toneClass}>{t(STATUS_LABEL_KEYS[snap.status]!)}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
