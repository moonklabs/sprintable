'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatRelativeTime } from '@/lib/storage/format';
import { formatScheduledAt } from '@/components/content/schedule-format';
// story #3746(유나 design gate CHANGES, 2026-09-09) — 이 유니온을 여기서 다시
// 정의하면 `components/insights-board/types.ts`의 같은 이름 정의와 «두 정본»이
// 된다 — 값이 지금은 여섯으로 일치해도, 한쪽만 고치면 다른 쪽 `Record` 가드가
// 조용히 안 걸린다(이 스토리가 닫으려던 결함 그대로 재발). 정의는 types.ts
// 한 곳에만 두고 여기선 import(정본↔사본 없음, 값 하나).
import type { InsightSnapshotStatus } from '@/components/insights-board/types';

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
  // story #3617(유나 3600 AC2 기준선) — 성과 보드로 가는 유일한 화면 내 길. 발행
  // 前(publication 없음)에는 undefined/null — 링크를 안 그린다(이 블록 자체도
  // snapshots.length===0이면 이미 안 그려지지만, publicationId 부재를 별도로도
  // 명시 방어한다 — "모른다≠다르다").
  publicationId?: string | null;
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
// captured/unsupported 값+라벨 신규, pending/failed는 §17-10 기존 두 enum 라벨
// 재사용(같은 사실을 두 벌로 안 쓴다). captured는 «비배지 원칙»(유나 지적) — 값이
// 있으면 값만 보이고 라벨은 안 그린다, 이 맵은 pending/failed 자리에만 실제로
// 쓰인다(captured는 아래 렌더 로직에서 애초에 이 맵을 안 거친다). unsupported는
// 이 맵에 없다 — §17-19 보강절이 "배지 라벨을 쓰는 자리가 없으면 그 키는 죽은
// 키다"로 직접 지적한 자리(문장 분기가 먼저 잡아 폴백까지 안 내려간다, 아래
// `insightSnapshotUnsupported` 참조) — 지웠다.
//
// story #3746(유나 v5, 2026-09-09) — `dead_letter`는 `InsightSnapshot.status`의
// 실 값이 아니었다(걷는다). `Partial<Record>`+`!`가 실사용 값(`in_progress`·
// `superseded`)이 빠진 구멍을 컴파일러에게 숨겨서, 오면 `t(undefined!)`가 될
// 자리였다 — `Record`(비-Partial)로 바꿔 하나라도 또 빠지면 빌드가 막는다.
const STATUS_LABEL_KEYS: Record<InsightSnapshotStatus, string> = {
  pending: 'insightStatusPending',
  in_progress: 'insightStatusPending',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  // 이 셋은 이 맵 자리엔 실제로 안 온다(unsupported·skipped는 렌더 분기가 먼저
  // 잡고, superseded는 BE가 기본 배제한다) — Record를 비-Partial로 유지하려면
  // 빠짐없이 채워야 하니 방어적으로 채운다(지어낸 값이 아니라 정직한 라벨).
  unsupported: 'insightStatusUnsupported',
  superseded: 'insightStatusSuperseded',
  // story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) — X 종량 read
  // 상한 도달 시 BE가 쓰는 값. 렌더 분기(아래)가 문장(insightSnapshotSkipped)으로
  // 먼저 잡으므로 이 명사구 라벨은 방어적 자리(unsupported/superseded와 동형).
  skipped: 'insightStatusSkipped',
};

// §17-18(doc a0da40c9) 톤 축 — "나쁜 소식인가"만 색을 가른다. failed만 destructive
// (FailureActionBadge와 동일 관례, failure-action-badge.tsx 참조) — 나머지(pending·
// in_progress·captured·unsupported·superseded·skipped)는 중립(유나: "unsupported는
// 실패가 아니라 성질, 경고색을 쓰면 고칠 것이 없는데 고치러 가게 된다" — skipped도
// 같은 이유: 우리 쪽 상한 설정의 결과지 그 발행물의 문제가 아니다).
const DESTRUCTIVE_STATUSES: ReadonlySet<InsightSnapshotStatus> = new Set(['failed']);

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

export function InsightSnapshotBlock({ snapshots, orgTimezone, locale, publicationId }: InsightSnapshotBlockProps) {
  const t = useTranslations('content');
  const tNav = useTranslations('nav');

  if (snapshots.length === 0) return null;

  const latest = findLatestCaptured(snapshots);

  return (
    <div
      data-testid="content-insight-info"
      className="space-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t('insightSectionLabel')}</p>
        {/* story #3617(유나 3600 AC2 기준선) — 마케팅 흐름(제작→승인→발행→댓글→성과)의
            마지막 구역 건너뛰기를 화면의 길로 없앤다. 기존 낱말("성과 보드", nav
            네임스페이스) 재사용 — 새 어휘 0. publicationId 없으면(발행 前) 안 그린다. */}
        {publicationId ? (
          <Link
            href={`/organization/insights-board?highlight=${encodeURIComponent(publicationId)}`}
            className="text-xs text-primary hover:underline"
            data-testid="insight-view-in-board-link"
          >
            {t('insightViewInBoardCta', { board: tNav('orgInsightsBoard') })}
          </Link>
        ) : null}
      </div>

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
              {(snap.status === 'pending' || snap.status === 'in_progress') && !snap.captured_at ? (
                <span className={toneClass} data-testid="insight-snapshot-pending">
                  {dueDisplay ? t('insightSnapshotPendingWithDue', { due: dueDisplay }) : t(STATUS_LABEL_KEYS[snap.status])}
                </span>
              ) : snap.status === 'unsupported' ? (
                <span className={toneClass} data-testid="insight-snapshot-unsupported">
                  {t('insightSnapshotUnsupported')}
                </span>
              ) : snap.status === 'skipped' ? (
                // story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) — X 종량
                // read 상한 도달. unsupported와 동형 문장 분기(중립 톤, 0으로 안 그린다
                // — 3-1 «수집 안 됨≠0» 규율 그대로).
                <span className={toneClass} data-testid="insight-snapshot-skipped">
                  {t('insightSnapshotSkipped')}
                </span>
              ) : snap.status === 'failed' ? (
                <span className={toneClass} data-testid="insight-snapshot-failure">
                  {/* story #3499 후속(페드루 지시·유나 3426 실픽셀, 2026-09-10) —
                      insights-board-metric-cell.tsx의 §17-10 상태 라벨(명사구·표 셀
                      전제)과 이 블록(문장·형제 unsupported도 문장)은 다른 문법을 요구해
                      한 키를 더는 같이 못 쓴다(전제가 바뀜 — 소비처 1곳 가정이 깨짐).
                      「다시 시도합니다」는 쓰지 않는다 — 이 화면엔 attempt_count가 안
                      내려와 재시도 여부를 화면이 모른다(모르는 것을 단정하지 않는다). */}
                  {t('insightSnapshotFailed')}
                </span>
              ) : snap.status === 'captured' && snap.captured_at ? (
                <span data-testid="insight-snapshot-captured">
                  {formatRelativeTime(snap.captured_at, locale, orgTimezone)}
                  {dueDisplay ? ` · ${dueDisplay}` : ''}
                </span>
              ) : (
                // 여기 도달하는 경우 — status==='captured'인데 captured_at이 null인
                // 방어적 엣지케이스(계약상 있어선 안 되지만 렌더가 죽지 않게), 또는
                // status==='superseded'(BE가 기본 배제하므로 사실상 안 오지만, Record
                // 완전성상 이 자리도 방어). unsupported는 위 분기가 이미 잡아 여기 안 옴.
                <span className={toneClass}>{t(STATUS_LABEL_KEYS[snap.status])}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
