import { describe, expect, it } from 'vitest';
import { deriveTrustStage, deriveInFlightTrustChip } from './verify';

describe('deriveTrustStage (claimed-vs-verified-spec-handoff §3 파생 규칙)', () => {
  it('returns "verified" when human_verified is true (green 무결성 — human_verified가 유일한 green 조건)', () => {
    expect(deriveTrustStage({ human_verified: true, self_reported: true })).toBe('verified');
  });

  it('returns "claimed" when self_reported is true but human_verified is not', () => {
    expect(deriveTrustStage({ self_reported: true, human_verified: null })).toBe('claimed');
    expect(deriveTrustStage({ self_reported: true, human_verified: false })).toBe('claimed');
  });

  it('returns null (무표시) when self_reported is falsy — D-03 완료 기준(증거 없는 Done은 승격 불가)', () => {
    expect(deriveTrustStage({ self_reported: null, human_verified: null })).toBeNull();
    expect(deriveTrustStage({})).toBeNull();
  });

  it('never returns "claimed" when human_verified is true, even if self_reported is somehow false (verified takes precedence)', () => {
    expect(deriveTrustStage({ self_reported: false, human_verified: true })).toBe('verified');
  });
});

describe('deriveInFlightTrustChip (trust-pipeline-minimal-decision — in-flight 전용 칩)', () => {
  it('returns "needs_input" when one of the 3 always-manual gate types is pending', () => {
    expect(deriveInFlightTrustChip('in-review', [{ gate_type: 'loop_decision', status: 'pending' }])).toBe('needs_input');
    expect(deriveInFlightTrustChip('in-review', [{ gate_type: 'doc_approval', status: 'pending' }])).toBe('needs_input');
    expect(deriveInFlightTrustChip('in-review', [{ gate_type: 'artifact_canonicalize', status: 'pending' }])).toBe('needs_input');
  });

  it('returns "merge_ready" when a pending merge gate has ci_result=pass', () => {
    expect(deriveInFlightTrustChip('in-review', [
      { gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } },
    ])).toBe('merge_ready');
  });

  it('never returns a chip when story.status is "done" — TrustSeal already owns that surface (no duplication)', () => {
    expect(deriveInFlightTrustChip('done', [{ gate_type: 'loop_decision', status: 'pending' }])).toBeNull();
    expect(deriveInFlightTrustChip('done', [
      { gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } },
    ])).toBeNull();
  });

  it('returns null when there is no honest signal (no-fiction — no gates, non-pending gates, or ci_result != pass)', () => {
    expect(deriveInFlightTrustChip('in-progress', [])).toBeNull();
    expect(deriveInFlightTrustChip('in-progress', [{ gate_type: 'loop_decision', status: 'approved' }])).toBeNull();
    expect(deriveInFlightTrustChip('in-progress', [
      { gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'fail' } },
    ])).toBeNull();
    expect(deriveInFlightTrustChip('in-progress', [{ gate_type: 'merge', status: 'pending' }])).toBeNull();
  });

  it('prefers merge_ready over needs_input when both are somehow pending simultaneously', () => {
    expect(deriveInFlightTrustChip('in-review', [
      { gate_type: 'loop_decision', status: 'pending' },
      { gate_type: 'merge', status: 'pending', neutral_facts: { ci_result: 'pass' } },
    ])).toBe('merge_ready');
  });
});
