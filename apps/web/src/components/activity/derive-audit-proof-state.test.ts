import { describe, expect, it } from 'vitest';
import { deriveAuditProofState } from './derive-audit-proof-state';

describe('deriveAuditProofState', () => {
  it('maps failure/rejection/violation vocabulary to red', () => {
    expect(deriveAuditProofState('gate.rejected')).toBe('red');
    expect(deriveAuditProofState('story.blocked')).toBe('red');
    expect(deriveAuditProofState('run.failed')).toBe('red');
    expect(deriveAuditProofState('policy.violation_detected')).toBe('red');
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
