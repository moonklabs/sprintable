import { describe, expect, it } from 'vitest';
import {
  deriveSilentStallClusters,
  type RawSilentStallItem,
  type RawSilentStallResponse,
} from './derive-silent-stall-clusters';

const NOW = Date.parse('2026-08-27T12:00:00Z');

function hoursAgo(h: number): string {
  return new Date(NOW - h * 60 * 60 * 1000).toISOString();
}

function item(overrides: Partial<RawSilentStallItem>): RawSilentStallItem {
  return {
    kind: 'stalled',
    story_id: 's1',
    title: 'T',
    entered_state_at: hoursAgo(72),
    entered_state_at_precision: 'exact',
    assignee_member_id: null,
    project_id: null,
    project_slug: null,
    ...overrides,
  };
}

function response(items: RawSilentStallItem[], populationCount = items.length): RawSilentStallResponse {
  return { items, stalled_computed_at: '2026-08-27T12:00:00Z', stalled_population_count: populationCount };
}

describe('deriveSilentStallClusters', () => {
  it('null 응답이면 빈 4구간(에러가 아니라 정직한 미가용)', () => {
    const clusters = deriveSilentStallClusters(null, undefined, NOW);
    expect(clusters.totalCount).toBe(0);
    expect(clusters.buckets).toHaveLength(4);
    expect(clusters.buckets.every((b) => b.items.length === 0)).toBe(true);
  });

  it('kind가 stalled가 아닌 항목(다른 5신호가 섞여 와도)은 무시한다', () => {
    const clusters = deriveSilentStallClusters(
      response([item({ kind: 'merge_ready', story_id: 's-mr' }), item({ story_id: 's-stalled' })]),
      undefined, NOW,
    );
    expect(clusters.totalCount).toBe(1);
    expect(clusters.buckets.flatMap((b) => b.items).map((i) => i.id)).toEqual(['s-stalled']);
  });

  it('4구간에 정확히 배분된다 — 48h-1w/1w-2w/2w-1mo/1mo+', () => {
    const clusters = deriveSilentStallClusters(
      response([
        item({ story_id: 's-48h', entered_state_at: hoursAgo(50) }),      // 48h-1w
        item({ story_id: 's-1w', entered_state_at: hoursAgo(24 * 8) }),    // 1w-2w
        item({ story_id: 's-2w', entered_state_at: hoursAgo(24 * 20) }),   // 2w-1mo
        item({ story_id: 's-1mo', entered_state_at: hoursAgo(24 * 45) }),  // 1mo+
      ]),
      undefined, NOW,
    );
    const byKey = Object.fromEntries(clusters.buckets.map((b) => [b.key, b.items.map((i) => i.id)]));
    expect(byKey['48h-1w']).toEqual(['s-48h']);
    expect(byKey['1w-2w']).toEqual(['s-1w']);
    expect(byKey['2w-1mo']).toEqual(['s-2w']);
    expect(byKey['1mo+']).toEqual(['s-1mo']);
  });

  it('구간 경계는 exclusive(하한 포함·상한 미포함) — 정확히 48h/1주/2주/1개월인 항목', () => {
    const clusters = deriveSilentStallClusters(
      response([
        item({ story_id: 's-exact-48h', entered_state_at: hoursAgo(48) }),
        item({ story_id: 's-exact-1w', entered_state_at: hoursAgo(24 * 7) }),
        item({ story_id: 's-exact-1mo', entered_state_at: hoursAgo(24 * 30) }),
      ]),
      undefined, NOW,
    );
    const byKey = Object.fromEntries(clusters.buckets.map((b) => [b.key, b.items.map((i) => i.id)]));
    expect(byKey['48h-1w']).toEqual(['s-exact-48h']);
    expect(byKey['1w-2w']).toEqual(['s-exact-1w']);
    expect(byKey['1mo+']).toEqual(['s-exact-1mo']);
  });

  it('BE가 준 순서(무변화 내림차순)를 그대로 보존한다 — 재정렬하지 않는다', () => {
    const clusters = deriveSilentStallClusters(
      response([
        item({ story_id: 's-oldest', entered_state_at: hoursAgo(24 * 40) }),
        item({ story_id: 's-newer', entered_state_at: hoursAgo(24 * 32) }),
      ]),
      undefined, NOW,
    );
    // 둘 다 1mo+ 버킷 — BE 순서(oldest 먼저) 그대로 유지돼야 한다.
    const bucket = clusters.buckets.find((b) => b.key === '1mo+')!;
    expect(bucket.items.map((i) => i.id)).toEqual(['s-oldest', 's-newer']);
  });

  it('populationCount·computedAt·totalCount를 raw에서 그대로 옮긴다(지어내지 않음)', () => {
    const clusters = deriveSilentStallClusters(response([item({})], 42), undefined, NOW);
    expect(clusters.totalCount).toBe(1);
    expect(clusters.populationCount).toBe(42);
    expect(clusters.computedAt).toBe('2026-08-27T12:00:00Z');
  });

  it('assigneeMemberId를 그대로 옮긴다(이름 해소는 렌더 몫)', () => {
    const clusters = deriveSilentStallClusters(
      response([item({ assignee_member_id: 'm1' })]), undefined, NOW,
    );
    expect(clusters.buckets.flatMap((b) => b.items)[0]!.assigneeMemberId).toBe('m1');
  });

  it('items가 배열이 아니면(형상 불일치 — 범용 fetch 스텁 등) crash 없이 빈 4구간으로 삼킨다', () => {
    const brokenShape = { items: 'not-an-array' } as unknown as RawSilentStallResponse;
    expect(() => deriveSilentStallClusters(brokenShape, undefined, NOW)).not.toThrow();
    expect(deriveSilentStallClusters(brokenShape, undefined, NOW).totalCount).toBe(0);
  });

  it('viewer 미제공이면 bare path로 폴백(회귀 0)', () => {
    const clusters = deriveSilentStallClusters(
      response([item({ story_id: 's1', project_id: 'p1', project_slug: 'sprintable' })]), undefined, NOW,
    );
    expect(clusters.buckets.flatMap((b) => b.items)[0]!.href).toBe('/board?story=s1');
  });

  // story #3153(93b076c8 후속, org-wide 커버리지) — 항목별 project_id/project_slug로
  // href/병기를 조립한다(더는 단일 activeProjectSlug 인자가 없음 — org-stalled가 여러
  // 프로젝트를 섞어 낼 수 있어서).
  describe('cross-project(story #3153)', () => {
    it('href는 그 항목 소속 프로젝트 slug로 지어진다(뷰어의 활성 프로젝트와 달라도)', () => {
      const clusters = deriveSilentStallClusters(
        response([item({ story_id: 's1', project_id: 'p-other', project_slug: 'other-proj' })]),
        { orgSlug: 'moonklabs', activeProjectId: 'p-active' }, NOW,
      );
      expect(clusters.buckets.flatMap((b) => b.items)[0]!.href).toBe('/moonklabs/other-proj/board?story=s1');
    });

    it('같은 프로젝트 소속이면 crossProjectLabel이 null(노이즈 절제)', () => {
      const clusters = deriveSilentStallClusters(
        response([item({ story_id: 's1', project_id: 'p-active', project_slug: 'sprintable' })]),
        { orgSlug: 'moonklabs', activeProjectId: 'p-active' }, NOW,
      );
      expect(clusters.buckets.flatMap((b) => b.items)[0]!.crossProjectLabel).toBeNull();
    });

    it('다른 프로젝트 소속이면 crossProjectLabel에 project_slug가 채워진다', () => {
      const clusters = deriveSilentStallClusters(
        response([item({ story_id: 's1', project_id: 'p-other', project_slug: 'other-proj' })]),
        { orgSlug: 'moonklabs', activeProjectId: 'p-active' }, NOW,
      );
      expect(clusters.buckets.flatMap((b) => b.items)[0]!.crossProjectLabel).toBe('other-proj');
    });

    it('서로 다른 두 프로젝트 항목이 한 버킷에 섞여도 각자 자기 slug로 href를 갖는다', () => {
      const clusters = deriveSilentStallClusters(
        response([
          item({ story_id: 's-a', project_id: 'p-a', project_slug: 'proj-a', entered_state_at: hoursAgo(72) }),
          item({ story_id: 's-b', project_id: 'p-b', project_slug: 'proj-b', entered_state_at: hoursAgo(80) }),
        ]),
        { orgSlug: 'moonklabs', activeProjectId: 'p-active' }, NOW,
      );
      const bucket = clusters.buckets.find((b) => b.key === '48h-1w')!;
      const byId = Object.fromEntries(bucket.items.map((i) => [i.id, i.href]));
      expect(byId['s-a']).toBe('/moonklabs/proj-a/board?story=s-a');
      expect(byId['s-b']).toBe('/moonklabs/proj-b/board?story=s-b');
    });
  });
});
