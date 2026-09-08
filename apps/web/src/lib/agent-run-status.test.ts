import { describe, expect, it } from 'vitest';
import { AGENT_RUN_STATUS_BADGE_VARIANT, AGENT_RUN_STATUS_ORDER, agentRunStatusBadgeVariant } from './agent-run-status';

// story #3689(3680 후속, 유나 確定) — abandoned(「미완」)은 failed(「실패」)와 다른
// 사실이라 다른 색이어야 한다. 폴백(모르는 상태=outline)과도 겹치면 안 된다.
describe('agent-run-status 카탈로그', () => {
  it('abandoned 변이는 failed와 다르다(warning≠destructive)', () => {
    expect(AGENT_RUN_STATUS_BADGE_VARIANT.abandoned).toBe('warning');
    expect(AGENT_RUN_STATUS_BADGE_VARIANT.abandoned).not.toBe(AGENT_RUN_STATUS_BADGE_VARIANT.failed);
  });

  it('abandoned 변이는 폴백(outline)과도 다르다', () => {
    expect(AGENT_RUN_STATUS_BADGE_VARIANT.abandoned).not.toBe('outline');
  });

  it('agentRunStatusBadgeVariant가 카탈로그 값을 그대로 되돌린다(전 상태)', () => {
    for (const status of AGENT_RUN_STATUS_ORDER) {
      expect(agentRunStatusBadgeVariant(status)).toBe(AGENT_RUN_STATUS_BADGE_VARIANT[status]);
    }
  });

  it('모르는 status 문자열은 outline으로 폴백한다', () => {
    expect(agentRunStatusBadgeVariant('never-seen-status')).toBe('outline');
  });
});
