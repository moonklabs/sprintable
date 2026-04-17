import { describe, it, expect } from 'vitest';
import { isValidStoryStatus, STORY_STATUSES } from './utils';

describe('isValidStoryStatus', () => {
  it('returns true for valid statuses', () => {
    for (const status of STORY_STATUSES) {
      expect(isValidStoryStatus(status)).toBe(true);
    }
  });

  it('returns false for invalid statuses', () => {
    expect(isValidStoryStatus('invalid')).toBe(false);
    expect(isValidStoryStatus('')).toBe(false);
    expect(isValidStoryStatus('DONE')).toBe(false);
  });
});

describe('STORY_STATUSES', () => {
  it('has 5 statuses', () => {
    expect(STORY_STATUSES).toHaveLength(5);
  });

  it('matches DB schema canonical set', () => {
    expect(STORY_STATUSES).toEqual([
      'backlog',
      'ready-for-dev',
      'in-progress',
      'in-review',
      'done',
    ]);
  });
});
