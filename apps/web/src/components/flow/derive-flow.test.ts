import { describe, expect, it } from 'vitest';
import { derivePastRatio, deriveEdgeSummary } from './derive-flow';

// story #4062 후속(2026-09-09, 페드루 PO 決) — deriveFlowLaneRows 테스트를 제거했다. 유일
// 소비처(FlowLane)가 #3710에서 삭제됐고 그 함수 자체도 derive-flow.ts에서 함께 삭제됐다.

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

// deriveFlowNodeZones 테스트(구 평면목록 렌더링용) 제거(2026-07-30) — 그 함수 자체가 아무도
// 안 부르는 죽은 코드가 되어 derive-flow.ts에서 삭제됐다. 그 자리는 이제
// derive-flow-map.test.ts의 deriveFlowMapLane 테스트가 지킨다(upcomingShown이 지키던
// "잘린 수를 정직하게" 규율은 그쪽에서 top-N 잘림 단계가 서면 이어받는다).
