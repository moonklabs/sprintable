import { describe, expect, it } from 'vitest';
import { deriveAuditProofState } from './derive-audit-proof-state';

describe('deriveAuditProofState', () => {
  it('maps genuine policy-violation/kill vocabulary to red', () => {
    expect(deriveAuditProofState('run.failed')).toBe('red');
    expect(deriveAuditProofState('policy.violation_detected')).toBe('red');
    expect(deriveAuditProofState('access.denied')).toBe('red');
    expect(deriveAuditProofState('run.errored')).toBe('red');
  });

  it('does NOT map reject to red (거부=학습 신호, 실패 아님 — amber로 완화)', () => {
    expect(deriveAuditProofState('gate.rejected')).toBe('amber');
  });

  it('does NOT map block to red (막힘=amber 규율 + story.unblocked 오탐 방지 — amber로 완화)', () => {
    expect(deriveAuditProofState('story.blocked')).toBe('amber');
    expect(deriveAuditProofState('story.unblocked')).toBe('amber');
  });

  it('maps completion/approval/creation vocabulary to green', () => {
    expect(deriveAuditProofState('story.completed')).toBe('green');
    expect(deriveAuditProofState('gate.approved')).toBe('green');
    expect(deriveAuditProofState('epic.created')).toBe('green');
    expect(deriveAuditProofState('pr.merged')).toBe('green');
  });

  it('maps in-flight/transition vocabulary to blue', () => {
    expect(deriveAuditProofState('story.status_changed')).toBe('blue');
    expect(deriveAuditProofState('run.started')).toBe('blue');
    expect(deriveAuditProofState('story.claimed')).toBe('blue');
    expect(deriveAuditProofState('task.assigned')).toBe('blue');
  });

  it('falls back to amber for unrecognized action vocabulary (honest neutral, not invented severity)', () => {
    expect(deriveAuditProofState('memo.viewed')).toBe('amber');
    expect(deriveAuditProofState('unknown.action')).toBe('amber');
  });

  it('is case-insensitive', () => {
    expect(deriveAuditProofState('STORY.COMPLETED')).toBe('green');
  });
});
