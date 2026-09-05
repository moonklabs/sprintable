'use client';

import type { useTranslations } from 'next-intl';
import type { InsightSnapshotBucketView } from './types';

// story #3503 — insight-snapshot-block.tsx(story #3499)의 패턴을 「표 셀 하나」 크기로
// 축소한 신규 컴포넌트(PO 브리프 — 그 컴포넌트를 통째로 재사용하지 않는다, due_at·source
// 등 히스토리 전용 필드가 이 버킷엔 없다). 재사용하는 것은 다음 세 원칙뿐:
//   ① i18n 키 재사용 — pending/captured/failed/dead_letter/unsupported는 이 파일이
//      새 키를 만들지 않고 content 네임스페이스의 기존 키를 그대로 부른다(같은 개념을
//      두 벌로 안 쓴다).
//   ② captured→값만(배지 없음) 원칙.
//   ③ failed/dead_letter만 destructive 톤, 나머지 중립.
//
// 이 버킷 자리는 원본 히스토리 목록과 달리 «세 겹 null 축»을 갖는다(PO 브리프 그대로):
//   (i)   bucket 자체가 null      → "아직 스케줄 안 됨"(unsupported와 다른 사유 — 이 파일
//         전용 신규 문구 insightsBoardBucketUnscheduled, insightSnapshotUnsupported와
//         혼동 방지를 위해 문구를 다르게 유지)
//   (ii)  bucket.status !== 'captured' → 상태 라벨만
//   (iii) bucket.status === 'captured' → REPRESENTATIVE_METRIC 값(§18-2 null/0 구분 재사용)
const STATUS_LABEL_KEYS: Partial<Record<InsightSnapshotBucketView['status'], string>> = {
  pending: 'insightStatusPending',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  dead_letter: 'insightStatusDeadLetter',
};

const DESTRUCTIVE_STATUSES: ReadonlySet<InsightSnapshotBucketView['status']> = new Set(['failed', 'dead_letter']);

export interface InsightsBoardMetricCellProps {
  bucket: InsightSnapshotBucketView | null;
  metric: keyof NonNullable<InsightSnapshotBucketView['normalized']>;
  /** content 네임스페이스 t — 상태/지표 라벨 재사용원. */
  tContent: ReturnType<typeof useTranslations>;
  /** insightsBoard 네임스페이스 t — 이 보드 전용 신규 문구(미스케줄 사유)만. */
  tBoard: ReturnType<typeof useTranslations>;
}

export function InsightsBoardMetricCell({ bucket, metric, tContent, tBoard }: InsightsBoardMetricCellProps) {
  // (i) 버킷 자체가 없음 — 아직 스케줄되지 않음/존재하지 않음.
  if (bucket === null) {
    return (
      <span data-testid="insights-board-cell-unscheduled">
        <span>{tContent('insightMetricUnavailableDash')}</span>
        <span className="ml-1 text-xs text-muted-foreground">{tBoard('insightsBoardBucketUnscheduled')}</span>
      </span>
    );
  }

  // (ii) 버킷은 있지만 아직 수집 완료 전(또는 실패/미지원) — 상태 라벨만.
  if (bucket.status !== 'captured') {
    const toneClass = DESTRUCTIVE_STATUSES.has(bucket.status) ? 'text-destructive' : 'text-muted-foreground';
    const label = bucket.status === 'unsupported'
      ? tContent('insightSnapshotUnsupported')
      : tContent(STATUS_LABEL_KEYS[bucket.status]!);
    return <span className={toneClass} data-testid="insights-board-cell-status">{label}</span>;
  }

  // (iii) captured — 대표 지표 값. normalized 자체가 없거나(방어적, 계약상 이례) 해당
  // 지표 키가 null이면(이 채널이 이 지표를 안 줌) §18-2 null↔0 구분 그대로 대시+사유.
  const value = bucket.normalized?.[metric] ?? null;
  if (value === null) {
    return (
      <span data-testid="insights-board-cell-value-dash">
        <span>{tContent('insightMetricUnavailableDash')}</span>
        <span className="ml-1 text-xs text-muted-foreground">{tContent('insightMetricUnavailableReason')}</span>
      </span>
    );
  }
  return <span data-testid="insights-board-cell-value">{value}</span>;
}
