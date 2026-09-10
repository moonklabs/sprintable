import { describe, expect, it } from 'vitest';
import { aggregateGroupBucket, groupInsightsBoardRows } from './group-rows';
import type { InsightsBoardRow } from './types';

function makeRow(overrides: Partial<InsightsBoardRow> & { publication_id: string }): InsightsBoardRow {
  return {
    kind: 'channel_publication', channel: 'instagram', work_item_id: 'wi-1',
    title: '제목', published_at: '2026-09-01T00:00:00Z', external_url: null,
    connection_id: null, d1: null, d7: null, comments_count: null,
    channel_post_draft_id: null, comments_last_collected_at: null, comments_supported: false,
    asset_sha256s: null, hook_key: null, command_status: null,
    ...overrides,
  };
}

const D1_A = { status: 'captured' as const, captured_at: '2026-09-02T00:00:00Z', normalized: {
  impressions: 100, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null,
  inflow_sessions: null, inflow_users: null,
} };
const D7_A = { status: 'captured' as const, captured_at: '2026-09-08T00:00:00Z', normalized: {
  impressions: 250, reach: null, views: null, engagements: null, clicks: null, spend: null, conversions: null,
  inflow_sessions: null, inflow_users: null,
} };

describe('groupInsightsBoardRows — story #3656', () => {
  it('mode=asset — 같은 asset_sha256s[0]을 공유하는 행이 한 그룹으로 묶이고 1d/7d 값은 각 행에 그대로 유지된다', () => {
    const rows: InsightsBoardRow[] = [
      makeRow({ publication_id: 'p1', channel: 'instagram', asset_sha256s: ['sha-aaaa1111bbbb'], d1: D1_A, d7: D7_A }),
      makeRow({ publication_id: 'p2', channel: 'facebook', asset_sha256s: ['sha-aaaa1111bbbb'], d1: D1_A, d7: D7_A }),
      makeRow({ publication_id: 'p3', channel: 'threads', asset_sha256s: ['sha-zzzz9999cccc'] }),
    ];
    const groups = groupInsightsBoardRows(rows, 'asset');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.rawKey).toBe('sha-aaaa1111bbbb');
    expect(groups[0]!.rows.map((r) => r.publication_id)).toEqual(['p1', 'p2']);
    // 1d/7d 값은 그룹핑이 손대지 않고 각 행에 그대로 남는다.
    expect(groups[0]!.rows[0]!.d1).toBe(D1_A);
    expect(groups[0]!.rows[1]!.d7).toBe(D7_A);
    expect(groups[1]!.rawKey).toBe('sha-zzzz9999cccc');
  });

  it('mode=hook — hook_key가 null인 행들은 하나의 미태깅 그룹(rawKey=null)으로 합쳐진다', () => {
    const rows: InsightsBoardRow[] = [
      makeRow({ publication_id: 'p1', hook_key: 'hook-A' }),
      makeRow({ publication_id: 'p2', hook_key: null }),
      makeRow({ publication_id: 'p3', hook_key: null }),
      makeRow({ publication_id: 'p4', hook_key: 'hook-B' }),
    ];
    const groups = groupInsightsBoardRows(rows, 'hook');
    expect(groups.map((g) => g.rawKey)).toEqual(['hook-A', null, 'hook-B']);
    const untagged = groups.find((g) => g.rawKey === null)!;
    expect(untagged.rows.map((r) => r.publication_id)).toEqual(['p2', 'p3']);
  });

  it('mode=none — 그룹마다 행이 정확히 1개(균일 렌더 경로), 순서는 입력 순서 그대로', () => {
    const rows: InsightsBoardRow[] = [
      makeRow({ publication_id: 'p1' }),
      makeRow({ publication_id: 'p2' }),
    ];
    const groups = groupInsightsBoardRows(rows, 'none');
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.rows.length === 1)).toBe(true);
    expect(groups.map((g) => g.rows[0]!.publication_id)).toEqual(['p1', 'p2']);
  });

  it('asset 그룹의 대표 키는 asset_sha256s의 «첫 번째» 값(캐러셀 순서 유지) — 두 번째 이후 값은 무시', () => {
    const rows: InsightsBoardRow[] = [
      makeRow({ publication_id: 'p1', asset_sha256s: ['first-sha', 'second-sha'] }),
    ];
    const groups = groupInsightsBoardRows(rows, 'asset');
    expect(groups[0]!.rawKey).toBe('first-sha');
  });
});

describe('aggregateGroupBucket — story #3656 페드루 確定 규칙', () => {
  const captured = (impressions: number | null, views: number | null = null) => ({
    status: 'captured' as const, captured_at: '2026-09-08T00:00:00Z',
    normalized: {
      impressions, reach: null, views, engagements: null, clicks: null, spend: null, conversions: null,
      inflow_sessions: null, inflow_users: null,
    },
  });

  it('구성원 전부 captured면 지표별로 합계한다', () => {
    const rows = [
      makeRow({ publication_id: 'p1', d1: captured(100, 5) }),
      makeRow({ publication_id: 'p2', d1: captured(150, 7) }),
    ];
    const agg = aggregateGroupBucket(rows, 'd1');
    expect(agg.status).toBe('captured');
    expect(agg.normalized?.impressions).toBe(250);
    expect(agg.normalized?.views).toBe(12);
  });

  it('구성원 중 하나라도 captured가 아니면(대기중·미존재 포함) 기존 pending 라벨을 재사용하는 합성 버킷을 낸다 — 새 상태 발명 0', () => {
    const rows = [
      makeRow({ publication_id: 'p1', d1: captured(100) }),
      makeRow({ publication_id: 'p2', d1: { status: 'pending' as const, normalized: null, captured_at: null } }),
      makeRow({ publication_id: 'p3', d1: null }),
    ];
    const agg = aggregateGroupBucket(rows, 'd1');
    expect(agg).toEqual({ status: 'pending', normalized: null, captured_at: null });
  });

  it('전부 captured여도 그 중 하나가 그 지표를 미제공(null)이면 합계도 null — 부분합으로 감추지 않는다(3321 원칙)', () => {
    const rows = [
      makeRow({ publication_id: 'p1', d1: captured(100) }),
      makeRow({ publication_id: 'p2', d1: captured(null) }), // 이 채널은 impressions를 안 줌
    ];
    const agg = aggregateGroupBucket(rows, 'd1');
    expect(agg.status).toBe('captured');
    expect(agg.normalized?.impressions).toBeNull();
  });
});
