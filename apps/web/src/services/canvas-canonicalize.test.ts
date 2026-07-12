import { describe, expect, it } from 'vitest';
import { derivePendingCanonicalizeVersion } from './canvas-canonicalize';

describe('derivePendingCanonicalizeVersion (gates 목록만으로 대기 중 정본 제안 버전 유도)', () => {
  it('returns null when there are no artifact_canonicalize gates', () => {
    expect(derivePendingCanonicalizeVersion([
      { gate_type: 'doc_approval', status: 'pending', neutral_facts: { version_number: 2 } },
    ])).toBeNull();
  });

  it('returns null when the only canonicalize gate is not pending', () => {
    expect(derivePendingCanonicalizeVersion([
      { gate_type: 'artifact_canonicalize', status: 'approved', neutral_facts: { version_number: 2 } },
    ])).toBeNull();
  });

  it('returns the version_number of a pending artifact_canonicalize gate', () => {
    expect(derivePendingCanonicalizeVersion([
      { gate_type: 'artifact_canonicalize', status: 'pending', neutral_facts: { version_number: 3 } },
    ])).toBe(3);
  });

  it('ignores gates with no neutral_facts or non-numeric version_number', () => {
    expect(derivePendingCanonicalizeVersion([
      { gate_type: 'artifact_canonicalize', status: 'pending', neutral_facts: null },
      { gate_type: 'artifact_canonicalize', status: 'pending', neutral_facts: { version_number: '3' } },
    ])).toBeNull();
  });

  it('picks the highest version_number when multiple pending canonicalize gates exist', () => {
    expect(derivePendingCanonicalizeVersion([
      { gate_type: 'artifact_canonicalize', status: 'pending', neutral_facts: { version_number: 2 } },
      { gate_type: 'artifact_canonicalize', status: 'pending', neutral_facts: { version_number: 4 } },
    ])).toBe(4);
  });
});
