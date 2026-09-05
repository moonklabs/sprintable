// story #3503(성과 보드 화면) — BE #3502(PR 아직 develop 미착지, origin/feat/3502-insights-board-api
// 브랜치 fd57310d4 기준)의 InsightsBoardRow/InsightSnapshotBucketView 계약을 FE 쪼갤 없이
// 그대로 옮긴 타입. BE 코드를 직접 import하지 않는다(스택 브랜치 아님, develop 기준 빌드) —
// 이 파일이 그 계약의 FE측 사본(fixture 기반 검증 축)이다.
//
// insight-snapshot-block.tsx(story #3499)의 InsightSnapshot과 형태가 비슷하지만 이 보드의
// d1/d7 버킷은 그 스냅샷 히스토리 항목과 다른 모양이다(due_at·source 필드가 없다 — 이
// 보드는 "지금 이 버킷이 어디 있나"만 보여주는 요약 뷰다, 히스토리 목록이 아니다).
export type InsightSnapshotStatus = 'pending' | 'captured' | 'unsupported' | 'failed' | 'dead_letter';

export interface InsightNormalizedMetrics {
  impressions: number | null;
  reach: number | null;
  views: number | null;
  engagements: number | null;
  clicks: number | null;
  spend: number | null;
  conversions: number | null;
}

// NULL(이 값 전체) — 이 버킷 자체가 아직 스케줄되지 않았음/존재하지 않음. bucket.normalized가
// null인 것(캡처됐지만 이 특정 지표를 못 줌)과는 다른 축 — 셀 컴포넌트가 이 둘을 분리해서 다룬다.
export interface InsightSnapshotBucketView {
  status: InsightSnapshotStatus;
  normalized: InsightNormalizedMetrics | null;
  captured_at: string | null;
}

export interface InsightsBoardRow {
  publication_id: string;
  kind: 'site_post' | 'channel_publication';
  channel: string;
  work_item_id: string;
  title: string;
  published_at: string;
  external_url: string | null;
  connection_id: string | null;
  d1: InsightSnapshotBucketView | null;
  d7: InsightSnapshotBucketView | null;
}

export interface InsightsBoardResponse {
  rows: InsightsBoardRow[];
  has_more: boolean;
  next_cursor: string | null;
}

export type InsightsBoardWindow = '7d' | '30d' | '90d';

// PO REQUEST(2026-09-05, PR#3853 리뷰) — 대표 지표를 impressions로 고정했더니
// hosted_site(블로그 beacon)는 views만 채우고 impressions는 늘 null이라 고객
// 1호(블로그+Threads)의 블로그 행이 전부 대시로 섰다. 지표를 «선택기»로 바꾼다 —
// 기본값 views, URL 파라미터 `metric`(기본값이면 생략). 7키 순서는 insight-
// snapshot-block.tsx(story #3499) METRIC_KEYS와 동일(그 파일의 i18n 라벨 재사용).
export const METRIC_KEYS = ['views', 'impressions', 'reach', 'engagements', 'clicks', 'spend', 'conversions'] as const;
export type BoardMetric = (typeof METRIC_KEYS)[number];
export const DEFAULT_METRIC: BoardMetric = 'views';

export type FollowUpKind = 'republish' | 'edit' | 'stop';

export interface FollowUpCreateResponse {
  story_id: string;
}
