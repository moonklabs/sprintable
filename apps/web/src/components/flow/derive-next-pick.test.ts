import { describe, expect, it } from 'vitest';
import { deriveNextPickCandidates, LONG_WAIT_DAYS, type NextPickCandidate } from './derive-next-pick';
import type { NextMakerStory } from './derive-next-maker';

const NOW = new Date('2026-07-31T00:00:00Z').getTime();

function story(overrides: Partial<NextMakerStory> = {}): NextMakerStory {
  return {
    id: 's1', storyNumber: 1, title: 'Story 1', status: 'backlog',
    assigneeId: null, updatedAt: '2026-07-30T00:00:00Z', epicId: 'e1',
    ...overrides,
  };
}

describe('deriveNextPickCandidates', () => {
  it('flags recently-spawned when the story id is in nextUpTargetIds', () => {
    const [c] = deriveNextPickCandidates([story()], new Set(['s1']), new Set(), NOW);
    expect(c.reasons).toContain('recently-spawned');
    expect(c.hasEvidence).toBe(true);
  });

  it('flags referenced when the story id is in referenceCandidateTargetIds', () => {
    const [c] = deriveNextPickCandidates([story()], new Set(), new Set(['s1']), NOW);
    expect(c.reasons).toContain('referenced');
  });

  it('flags owned when assigneeId is present', () => {
    const [c] = deriveNextPickCandidates([story({ assigneeId: 'u1' })], new Set(), new Set(), NOW);
    expect(c.reasons).toContain('owned');
  });

  it('flags long-waiting at exactly the threshold day, not before', () => {
    const justUnder = new Date(NOW - (LONG_WAIT_DAYS - 1) * 86_400_000).toISOString();
    const atThreshold = new Date(NOW - LONG_WAIT_DAYS * 86_400_000).toISOString();
    const [under] = deriveNextPickCandidates([story({ updatedAt: justUnder })], new Set(), new Set(), NOW);
    const [at] = deriveNextPickCandidates([story({ updatedAt: atThreshold })], new Set(), new Set(), NOW);
    expect(under.reasons).not.toContain('long-waiting');
    expect(at.reasons).toContain('long-waiting');
  });

  it('a story with none of the four signals still appears, with hasEvidence=false — never filtered out', () => {
    const [c] = deriveNextPickCandidates([story({ updatedAt: new Date(NOW).toISOString() })], new Set(), new Set(), NOW);
    expect(c.hasEvidence).toBe(false);
    expect(c.reasons).toEqual([]);
  });

  it('sorts by reason count desc, then waitingDays desc as tiebreak', () => {
    // "old-no-owner" crosses LONG_WAIT_DAYS on its own (1 reason: long-waiting) — deliberately
    // distinct from "zero-evidence-recent" (0 reasons) so the reason-count ordering is unambiguous.
    const stories = [
      story({ id: 'old-no-owner', updatedAt: new Date(NOW - 100 * 86_400_000).toISOString() }),
      story({ id: 'zero-evidence-recent', updatedAt: new Date(NOW).toISOString() }),
      story({ id: 'two-evidence', assigneeId: 'u1', updatedAt: new Date(NOW).toISOString() }),
      story({ id: 'one-evidence-recent', assigneeId: 'u1', updatedAt: new Date(NOW).toISOString() }),
    ];
    const result = deriveNextPickCandidates(
      stories,
      new Set(['two-evidence']), // adds recently-spawned on top of owned → 2 reasons
      new Set(),
      NOW,
    );
    expect(result.map((c) => c.story.id)).toEqual([
      'two-evidence', 'old-no-owner', 'one-evidence-recent', 'zero-evidence-recent',
    ]);
  });

  it('does not mutate the input array', () => {
    const stories = [story({ id: 'b' }), story({ id: 'a' })];
    const original = stories.map((s) => s.id);
    deriveNextPickCandidates(stories, new Set(), new Set(), NOW);
    expect(stories.map((s) => s.id)).toEqual(original);
  });

  it('empty backlog → empty result, no crash', () => {
    const result: NextPickCandidate[] = deriveNextPickCandidates([], new Set(), new Set(), NOW);
    expect(result).toEqual([]);
  });
});
