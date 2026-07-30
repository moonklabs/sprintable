import { describe, expect, it } from 'vitest';
import type { RoadmapEpic } from '@/services/glance';
import {
  deriveFlowLaneRows, derivePastRatio, deriveEdgeSummary, FLOW_LANE_CAP,
  deriveFlowNodeZones, type EpicFlowNodesResponse, type EpicsProgressLaneResponse,
} from './derive-flow';

function makeEpic(overrides: Partial<RoadmapEpic> = {}): RoadmapEpic {
  return {
    id: 'e1',
    title: 'Epic 1',
    roadmapStatus: 'active',
    done: 2,
    total: 10,
    completionPct: 20,
    ...overrides,
  };
}

function makeLaneData(overrides: Partial<EpicsProgressLaneResponse> = {}): EpicsProgressLaneResponse {
  return {
    epics: {
      e1: { in_progress: 2, waiting: 3, blocked: 1, stalled: 0, other: 4 },
    },
    zones: {
      e1: { title: 'Epic 1', total: 10, done: 4, pct: 40, past_cnt: 4, now_cnt: 2, upcoming_cnt: 4 },
    },
    stall_threshold_hours: 168,
    stories_without_epic: 0,
    ...overrides,
  };
}

describe('deriveFlowLaneRows', () => {
  it('reads done/total/completionPct from zones (not roadmap) when laneData has the epic', () => {
    const rows = deriveFlowLaneRows([makeEpic()], makeLaneData());
    expect(rows).toEqual([{
      id: 'e1', title: 'Epic 1', done: 4, total: 10, completionPct: 40,
      inProgress: 2, waiting: 3, blocked: 1, stalled: 0,
      pastCnt: 4, nowCnt: 2, upcomingCnt: 4, hasLaneData: true,
    }]);
  });

  it('falls back to roadmap done/total/completionPct and all-zero flags when the epic has no lane data (0-story epic)', () => {
    const rows = deriveFlowLaneRows([makeEpic({ id: 'e2', done: 0, total: 0, completionPct: 0 })], makeLaneData());
    expect(rows).toEqual([{
      id: 'e2', title: 'Epic 1', done: 0, total: 0, completionPct: 0,
      inProgress: 0, waiting: 0, blocked: 0, stalled: 0,
      pastCnt: 0, nowCnt: 0, upcomingCnt: 0, hasLaneData: false,
    }]);
  });

  it('falls back to roadmap fields and hasLaneData=false when laneData itself is null (fetch not done/failed)', () => {
    const rows = deriveFlowLaneRows([makeEpic()], null);
    expect(rows).toEqual([{
      id: 'e1', title: 'Epic 1', done: 2, total: 10, completionPct: 20,
      inProgress: 0, waiting: 0, blocked: 0, stalled: 0,
      pastCnt: 0, nowCnt: 0, upcomingCnt: 0, hasLaneData: false,
    }]);
  });

  it('caps at FLOW_LANE_CAP', () => {
    const epics = Array.from({ length: FLOW_LANE_CAP + 5 }, (_, i) => makeEpic({ id: `e${i}` }));
    const rows = deriveFlowLaneRows(epics, null);
    expect(rows).toHaveLength(FLOW_LANE_CAP);
  });

  it('returns empty array for empty input (no invented rows)', () => {
    expect(deriveFlowLaneRows([], null)).toEqual([]);
  });
});

describe('derivePastRatio', () => {
  it('computes a rounded percentage', () => {
    expect(derivePastRatio(1, 3)).toBe(33);
  });

  it('returns 0 when total is 0 (not-started, not a division error)', () => {
    expect(derivePastRatio(0, 0)).toBe(0);
  });

  it('clamps to 100 even if done exceeds total (defensive)', () => {
    expect(derivePastRatio(12, 10)).toBe(100);
  });

  it('never returns negative', () => {
    expect(derivePastRatio(-5, 10)).toBe(0);
  });
});

describe('deriveEdgeSummary', () => {
  it('marks isEmpty when count is 0', () => {
    expect(deriveEdgeSummary(0)).toEqual({ count: 0, isEmpty: true });
  });

  it('does not mark isEmpty for a nonzero count', () => {
    expect(deriveEdgeSummary(3)).toEqual({ count: 3, isEmpty: false });
  });
});

function makeNode(overrides: Partial<EpicFlowNodesResponse['now']['items'][number]> = {}) {
  return { id: 's1', story_number: 1, title: 'Story', status: 'in-progress', assignee_id: null, updated_at: '2026-07-30T00:00:00Z', ...overrides };
}

describe('deriveFlowNodeZones', () => {
  it('carries now/upcoming items+total and past total through untouched(no re-sort/re-filter — BE 계약이 이미 정렬을 확定)', () => {
    const response: EpicFlowNodesResponse = {
      epic_id: 'e1',
      now: { total: 5, items: [makeNode({ id: 'n1' }), makeNode({ id: 'n2', status: 'in-review' })] },
      upcoming: { total: 67, items: [makeNode({ id: 'u1' }), makeNode({ id: 'u2' })] },
      past: { total: 72 },
    };
    expect(deriveFlowNodeZones(response)).toEqual({
      nowItems: response.now.items,
      nowTotal: 5,
      upcomingItems: response.upcoming.items,
      upcomingTotal: 67,
      upcomingShown: 2,
      pastTotal: 72,
    });
  });

  it('derives upcomingShown from actual items.length, not from upcoming.total(잘린 수를 정직하게 — total과 items.length가 다를 수 있다는 계약)', () => {
    const response: EpicFlowNodesResponse = {
      epic_id: 'e1',
      now: { total: 0, items: [] },
      upcoming: { total: 67, items: [makeNode()] },
      past: { total: 0 },
    };
    expect(deriveFlowNodeZones(response).upcomingShown).toBe(1);
  });

  it('handles all-zero zones (genuinely empty epic) without inventing data', () => {
    const response: EpicFlowNodesResponse = {
      epic_id: 'e1',
      now: { total: 0, items: [] },
      upcoming: { total: 0, items: [] },
      past: { total: 0 },
    };
    expect(deriveFlowNodeZones(response)).toEqual({
      nowItems: [], nowTotal: 0, upcomingItems: [], upcomingTotal: 0, upcomingShown: 0, pastTotal: 0,
    });
  });
});
