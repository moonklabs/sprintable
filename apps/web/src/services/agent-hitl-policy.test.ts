import { describe, expect, it } from 'vitest';
import {
  buildHitlPolicySnapshot,
  getDefaultHitlPolicySnapshot,
  resolveHitlApprovalRule,
  resolveHitlTimeoutClass,
} from './agent-hitl-policy';

describe('agent-hitl-policy', () => {
  it('returns the default snapshot with catalog, approval rules, and timeout classes', () => {
    const snapshot = getDefaultHitlPolicySnapshot();

    expect(snapshot.high_risk_actions).toHaveLength(3);
    expect(resolveHitlApprovalRule(snapshot, 'manual_hitl_request')).toMatchObject({
      request_type: 'approval',
      timeout_class: 'standard',
    });
    expect(resolveHitlTimeoutClass(snapshot, 'fast')).toMatchObject({
      duration_minutes: 240,
      reminder_minutes_before: 60,
      escalation_mode: 'timeout_memo_and_escalate',
    });
    expect(snapshot.prompt_summary).toContain('High-risk action catalog');
  });

  it('merges persisted overrides onto the default policy contract and normalizes legacy request types', () => {
    const snapshot = buildHitlPolicySnapshot({
      schema_version: 1,
      approval_rules: [
        {
          key: 'billing_cap_exceeded',
          request_type: 'escalation',
          timeout_class: 'fast',
          approval_required: true,
        },
      ],
      timeout_classes: [
        {
          key: 'fast',
          duration_minutes: 90,
          reminder_minutes_before: 15,
          escalation_mode: 'timeout_memo_and_escalate',
        },
      ],
    });

    expect(resolveHitlApprovalRule(snapshot, 'manual_hitl_request')).toMatchObject({
      request_type: 'approval',
      timeout_class: 'standard',
    });
    expect(resolveHitlApprovalRule(snapshot, 'billing_cap_exceeded')).toMatchObject({
      request_type: 'approval',
      timeout_class: 'fast',
    });
    expect(resolveHitlTimeoutClass(snapshot, 'fast')).toMatchObject({
      duration_minutes: 90,
      reminder_minutes_before: 15,
      escalation_mode: 'timeout_memo_and_escalate',
    });
    expect(snapshot.prompt_summary).toContain('billing_cap_exceeded -> approval');
    expect(snapshot.prompt_summary).not.toContain('escalation');
  });
});
