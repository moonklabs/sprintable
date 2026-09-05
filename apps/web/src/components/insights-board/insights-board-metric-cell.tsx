'use client';

import type { useTranslations } from 'next-intl';
import type { InsightSnapshotBucketView } from './types';

// story #3503 — insight-snapshot-block.tsx(story #3499)의 패턴을 「표 셀 하나」 크기로
// 축소한 신규 컴포넌트(PO 브리프 — 그 컴포넌트를 통째로 재사용하지 않는다, due_at·source
// 등 히스토리 전용 필드가 이 버킷엔 없다). 재사용하는 것은 다음 세 원칙뿐:
//   ① i18n 키 재사용 — pending/captured/failed/dead_letter/unsupported 상태 «라벨»은
//      content 네임스페이스 기존 키를 그대로 부른다(같은 개념을 두 벌로 안 쓴다).
//   ② captured→값만(배지 없음) 원칙.
//   ③ failed/dead_letter만 destructive 톤, 나머지 중립.
//
// doc a0da40c9 §21-2(유나 2026-09-05, 정정) — 표 칸은 «문장이 아니라 명사구»다(6열
// 표에서 문장은 행 높이를 무너뜨린다). §17-19가 이미 "배지·API·툴팁=문장, 자리가
// 좁으면 명사구"로 갈라 뒀다 — 표 칸이 그 좁은 자리다. 그래서:
//   - unsupported 사유는 insight-snapshot-block.tsx가 쓰는 문장(insightSnapshotUnsupported)이
//     아니라 되살린 명사구 키 insightStatusUnsupported("채널 미제공")를 쓴다 — §21-2가
//     "PR#3846에서 죽은 키라 지운 것을 판단 조건(닿는 자리 유무)이 바뀌어 되살린다"고
//     명시한 바로 그 키.
//   - captured인데 지표 값이 null인 사유도 문장(insightMetricUnavailableReason)이 아니라
//     이 보드 전용 명사구 insightsBoardMetricUnavailable("지표 미제공")를 쓴다.
//   - 버킷 자체가 null인 사유는 insightsBoardBucketUnscheduled 자체를 명사구
//     ("집계 예정 없음")로 바꿔 그대로 재사용한다.
const STATUS_LABEL_KEYS: Partial<Record<InsightSnapshotBucketView['status'], string>> = {
  pending: 'insightStatusPending',
  captured: 'insightStatusCaptured',
  failed: 'insightStatusFailed',
  dead_letter: 'insightStatusDeadLetter',
  unsupported: 'insightStatusUnsupported',
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

  // (ii) 버킷은 있지만 아직 수집 완료 전(또는 실패/미지원) — 상태 라벨만(명사구).
  if (bucket.status !== 'captured') {
    const toneClass = DESTRUCTIVE_STATUSES.has(bucket.status) ? 'text-destructive' : 'text-muted-foreground';
    return <span className={toneClass} data-testid="insights-board-cell-status">{tContent(STATUS_LABEL_KEYS[bucket.status]!)}</span>;
  }

  // (iii) captured — 선택 지표 값. normalized 자체가 없거나(방어적, 계약상 이례) 해당
  // 지표 키가 null이면(이 채널이 이 지표를 안 줌) §18-2 null↔0 구분 그대로 대시+사유
  // (§21-2 — 사유는 명사구 insightsBoardMetricUnavailable, 문장 아님).
  const value = bucket.normalized?.[metric] ?? null;
  if (value === null) {
    return (
      <span data-testid="insights-board-cell-value-dash">
        <span>{tContent('insightMetricUnavailableDash')}</span>
        <span className="ml-1 text-xs text-muted-foreground">{tBoard('insightsBoardMetricUnavailable')}</span>
      </span>
    );
  }
  return <span data-testid="insights-board-cell-value">{value}</span>;
}
