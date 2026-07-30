import { describe, expect, it } from 'vitest';
import type { RoadmapEpic } from '@/services/glance';
import { deriveFlowLaneRows, derivePastRatio, deriveEdgeSummary, FLOW_LANE_CAP } from './derive-flow';

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

describe('deriveFlowLaneRows', () => {
  it('maps only the display fields (id/title/done/total/completionPct)', () => {
    const rows = deriveFlowLaneRows([makeEpic()]);
    expect(rows).toEqual([{ id: 'e1', title: 'Epic 1', done: 2, total: 10, completionPct: 20 }]);
  });

  it('caps at FLOW_LANE_CAP', () => {
    const epics = Array.from({ length: FLOW_LANE_CAP + 5 }, (_, i) => makeEpic({ id: `e${i}` }));
    const rows = deriveFlowLaneRows(epics);
    expect(rows).toHaveLength(FLOW_LANE_CAP);
  });

  it('returns empty array for empty input (no invented rows)', () => {
    expect(deriveFlowLaneRows([])).toEqual([]);
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
