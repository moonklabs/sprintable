import { METRIC_KEYS, type InsightNormalizedMetrics, type InsightSnapshotBucketView, type InsightsBoardRow } from './types';

// story #3656(Phase2·FE+BE, 페드루 PO 確定 2026-09-07) — 같은 소재(asset_sha256s)가
// 채널 여러 곳으로 나갔을 때, 또는 같은 훅(hook_key)을 쓴 발행물끼리 한 화면에서
// 비교한다(블루프린트 §7 「성과가 소재 단위로 돌아온다」). 순수 함수(DOM·React 의존
// 0) — groupKey/label 텍스트는 여기서 만들지 않는다(i18n은 렌더 레이어 몫, «미태깅»
// 문구는 유나 확定 대상이라 하드코딩하지 않는다 — rawKey가 null이면 렌더 레이어가
// 그 자리에 미태깅 라벨을 채운다).
export type InsightsBoardGroupBy = 'asset' | 'hook' | 'none';

export interface InsightsBoardGroup {
  // React key·안정적 식별자. rawKey가 있으면 그 값 그대로, 없으면(미태깅) 고정
  // 센티널 — 두 개의 다른 미태깅 그룹이 우연히 같은 key로 합쳐지지 않게 mode를 섞는다.
  groupKey: string;
  // 소재 그룹=asset_sha256s[0](대표 소재 — 캐러셀은 첫 장), 훅 그룹=hook_key,
  // none 모드=publication_id(그룹마다 행 정확히 1개). null=미태깅(그 축의 값이
  // 이 발행물에 없음 — site_post·이미지/영상 0건·hook_key 미기입).
  rawKey: string | null;
  rows: InsightsBoardRow[];
}

// 페드루 PO 確定 — 소재 그룹의 대표 표시는 sha256 앞 8자(전체 64자를 행마다 새로
// 안 보여준다, 카드/배지 폭 절약 — 유나 §절에서 자리 확定).
export const ASSET_LABEL_PREFIX_LENGTH = 8;

function primaryAssetSha(row: InsightsBoardRow): string | null {
  return row.asset_sha256s && row.asset_sha256s.length > 0 ? row.asset_sha256s[0]! : null;
}

/** rows를 groupBy 축으로 묶는다 — 순서는 첫 등장 순(행 fetch 순서, 보통
 * published_at desc)을 그대로 보존한다. mode='none'이면 행마다 그룹 1개(균일한
 * 렌더 경로 — 호출부가 "그룹 있음/없음"을 따로 분기하지 않아도 된다). */
export function groupInsightsBoardRows(
  rows: InsightsBoardRow[], mode: InsightsBoardGroupBy,
): InsightsBoardGroup[] {
  if (mode === 'none') {
    return rows.map((row) => ({ groupKey: row.publication_id, rawKey: row.publication_id, rows: [row] }));
  }

  const groups = new Map<string, InsightsBoardGroup>();
  const order: string[] = [];
  for (const row of rows) {
    const rawKey = mode === 'asset' ? primaryAssetSha(row) : row.hook_key;
    const mapKey = rawKey ?? `__untagged_${mode}__`;
    let group = groups.get(mapKey);
    if (!group) {
      group = { groupKey: mapKey, rawKey, rows: [] };
      groups.set(mapKey, group);
      order.push(mapKey);
    }
    group.rows.push(row);
  }
  return order.map((k) => groups.get(k)!);
}

// 페드루 PO 確定(2026-09-07) — 묶음 행의 d1/d7 칸 규칙: 구성원 «전부 captured»일 때만
// 지표별 합계, 일부만 captured면 그 칸은 기존 pending 상태 라벨(content.
// insightStatusPending, 「대기 중」)을 그대로 재사용한다(다섯째 낱말 안 만든다,
// InsightsBoardMetricCell의 기존 4상태 분기를 그대로 태우려고 «진짜 버킷처럼 생긴»
// 합성 버킷을 돌려준다 — 이 함수의 반환값을 InsightsBoardMetricCell에 그대로
// bucket prop으로 넘기면 새 렌더 분기가 0이다).
//
// 지표별 null 처리(3321 원칙 — 0과 null을 안 섞는다) — 구성원 전부가 captured여도
// 그 중 하나라도 이 지표 값이 null(그 채널이 이 지표를 선언 안 함)이면 합계 자체가
// null이다(«일부는 있고 일부는 없다»를 부분합으로 감추지 않는다 — 3651 델타 계산의
// «한쪽이라도 null이면 델타도 null» 규율과 같은 정신).
export function aggregateGroupBucket(
  rows: InsightsBoardRow[], bucketKey: 'd1' | 'd7',
): InsightSnapshotBucketView {
  const buckets = rows.map((row) => row[bucketKey]);
  const allCaptured = buckets.every((b): b is InsightSnapshotBucketView => b !== null && b.status === 'captured');
  if (!allCaptured) {
    return { status: 'pending', normalized: null, captured_at: null };
  }
  const normalized = {} as InsightNormalizedMetrics;
  for (const key of METRIC_KEYS) {
    const values = buckets.map((b) => b!.normalized?.[key] ?? null);
    normalized[key] = values.some((v) => v === null)
      ? null
      : values.reduce<number>((sum, v) => sum + (v as number), 0);
  }
  return { status: 'captured', normalized, captured_at: null };
}
