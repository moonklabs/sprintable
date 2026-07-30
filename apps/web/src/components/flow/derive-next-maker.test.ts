import { describe, expect, it } from 'vitest';
import {
  parseGoals, parseStories, parseNextUp,
  deriveGoalStems, deriveRecentlyClosedEpicIds, sortStemsByStallUrgency,
  deriveHeadline, deriveZeroStageStats,
  type NextMakerGoal, type NextMakerStory,
} from './derive-next-maker';

function goal(overrides: Partial<NextMakerGoal> = {}): NextMakerGoal {
  return { id: 'e1', title: 'Epic 1', totalStories: 10, doneStories: 2, ...overrides };
}

function story(overrides: Partial<NextMakerStory> = {}): NextMakerStory {
  return {
    id: 's1', storyNumber: 1, title: 'Story 1', status: 'backlog',
    assigneeId: null, updatedAt: '2026-07-01T00:00:00Z', epicId: 'e1',
    ...overrides,
  };
}

describe('parseGoals / parseStories / parseNextUp', () => {
  it('maps snake_case BE fields to camelCase', () => {
    expect(parseGoals([{ id: 'e1', title: 'T', total_stories: 5, done_stories: 2 }]))
      .toEqual([{ id: 'e1', title: 'T', totalStories: 5, doneStories: 2 }]);
    expect(parseStories([{
      id: 's1', story_number: 1, title: 'S', status: 'backlog',
      assignee_id: 'u1', updated_at: '2026-07-01T00:00:00Z', epic_id: 'e1',
    }])).toEqual([{
      id: 's1', storyNumber: 1, title: 'S', status: 'backlog',
      assigneeId: 'u1', updatedAt: '2026-07-01T00:00:00Z', epicId: 'e1',
    }]);
    expect(parseNextUp([{
      id: 'n1', source_id: 'd1', source_story_number: 10, source_title: 'D',
      source_closed_at: '2026-07-20T00:00:00Z', target_id: 't1', target_story_number: 11,
      target_title: 'T', relation_kind: 'spawned', status: 'estimated', is_recent: true,
    }])).toEqual([{
      id: 'n1', sourceId: 'd1', sourceStoryNumber: 10, sourceTitle: 'D',
      sourceClosedAt: '2026-07-20T00:00:00Z', targetId: 't1', targetStoryNumber: 11,
      targetTitle: 'T', relationKind: 'spawned', status: 'estimated', isRecent: true,
    }]);
  });
});

describe('deriveGoalStems', () => {
  it('hasNext=true when the goal has a ready-for-dev story, regardless of other statuses', () => {
    const stems = deriveGoalStems(
      [goal()],
      [story({ status: 'ready-for-dev' }), story({ id: 's2', status: 'backlog' })],
      new Set(),
    );
    expect(stems[0].hasNext).toBe(true);
    expect(stems[0].priority).toBeNull();
    expect(stems[0].readyForDevCount).toBe(1);
    expect(stems[0].waitingCount).toBe(1);
  });

  it('priority=about-to-stall when in-progress exists but no ready-for-dev', () => {
    const stems = deriveGoalStems([goal()], [story({ status: 'in-progress' })], new Set());
    expect(stems[0].hasNext).toBe(false);
    expect(stems[0].priority).toBe('about-to-stall');
    expect(stems[0].inProgressCount).toBe(1);
  });

  it('in-review counts as "now" the same as in-progress for stall detection', () => {
    const stems = deriveGoalStems([goal()], [story({ status: 'in-review' })], new Set());
    expect(stems[0].priority).toBe('about-to-stall');
  });

  it('priority=recently-active when no in-progress but epic is in recentlyClosedEpicIds', () => {
    const stems = deriveGoalStems([goal()], [], new Set(['e1']));
    expect(stems[0].priority).toBe('recently-active');
  });

  it('priority=quiet when neither in-progress nor recently closed', () => {
    const stems = deriveGoalStems([goal()], [story({ status: 'backlog' })], new Set());
    expect(stems[0].priority).toBe('quiet');
  });

  it('a goal with zero stories is quiet, not a crash', () => {
    const stems = deriveGoalStems([goal({ id: 'e2', totalStories: 0, doneStories: 0 })], [], new Set());
    expect(stems[0]).toMatchObject({ inProgressCount: 0, waitingCount: 0, readyForDevCount: 0, priority: 'quiet' });
  });

  it('stories without epicId are ignored (never crash, never misattributed)', () => {
    const stems = deriveGoalStems([goal()], [story({ epicId: null, status: 'ready-for-dev' })], new Set());
    expect(stems[0].hasNext).toBe(false);
  });
});

describe('deriveRecentlyClosedEpicIds', () => {
  it('joins next-up target_id against active stories to resolve epicId, isRecent only', () => {
    const nextUp = [
      { id: 'n1', sourceId: 'd1', sourceStoryNumber: 1, sourceTitle: 'D', sourceClosedAt: '', targetId: 's1', targetStoryNumber: 2, targetTitle: 'T', relationKind: 'spawned', status: 'estimated', isRecent: true },
      { id: 'n2', sourceId: 'd2', sourceStoryNumber: 3, sourceTitle: 'D2', sourceClosedAt: '', targetId: 's2', targetStoryNumber: 4, targetTitle: 'T2', relationKind: 'spawned', status: 'estimated', isRecent: false },
    ];
    const active = [story({ id: 's1', epicId: 'e1' }), story({ id: 's2', epicId: 'e2' })];
    expect(deriveRecentlyClosedEpicIds(nextUp, active)).toEqual(new Set(['e1']));
  });

  it('target_id with no matching active story (already picked/closed) contributes nothing', () => {
    const nextUp = [{ id: 'n1', sourceId: 'd1', sourceStoryNumber: 1, sourceTitle: 'D', sourceClosedAt: '', targetId: 'gone', targetStoryNumber: 2, targetTitle: 'T', relationKind: null, status: 'estimated', isRecent: true }];
    expect(deriveRecentlyClosedEpicIds(nextUp, [])).toEqual(new Set());
  });
});

describe('sortStemsByStallUrgency', () => {
  it('orders about-to-stall > recently-active > quiet, has-next(null priority) last', () => {
    const stems = deriveGoalStems(
      [goal({ id: 'quiet' }), goal({ id: 'stall' }), goal({ id: 'active' }), goal({ id: 'has-next' })],
      [
        story({ epicId: 'stall', status: 'in-progress' }),
        story({ epicId: 'has-next', status: 'ready-for-dev' }),
      ],
      new Set(['active']),
    );
    const sorted = sortStemsByStallUrgency(stems);
    expect(sorted.map((s) => s.epicId)).toEqual(['stall', 'active', 'quiet', 'has-next']);
  });

  it('does not mutate the input array', () => {
    const stems = deriveGoalStems([goal({ id: 'a' }), goal({ id: 'b' })], [], new Set());
    const original = stems.map((s) => s.epicId);
    sortStemsByStallUrgency(stems);
    expect(stems.map((s) => s.epicId)).toEqual(original);
  });
});

describe('deriveHeadline', () => {
  it('counts needsNext/aboutToStall/quiet/hasNext correctly', () => {
    const stems = deriveGoalStems(
      [goal({ id: 'stall' }), goal({ id: 'active' }), goal({ id: 'quiet' }), goal({ id: 'has-next' })],
      [
        story({ epicId: 'stall', status: 'in-progress' }),
        story({ epicId: 'has-next', status: 'ready-for-dev' }),
      ],
      new Set(['active']),
    );
    expect(deriveHeadline(stems)).toEqual({
      totalGoals: 4, needsNextCount: 3, aboutToStallCount: 1, quietCount: 1, hasNextCount: 1,
    });
  });

  it('all goals have next → 0/0/0 needing, matches total', () => {
    const stems = deriveGoalStems([goal()], [story({ status: 'ready-for-dev' })], new Set());
    expect(deriveHeadline(stems)).toEqual({
      totalGoals: 1, needsNextCount: 0, aboutToStallCount: 0, quietCount: 0, hasNextCount: 1,
    });
  });
});

describe('deriveZeroStageStats', () => {
  it('splits ready-for-dev by owner presence, backlog total+owned, passes through blocked', () => {
    const stats = deriveZeroStageStats([
      story({ id: 's1', status: 'ready-for-dev', assigneeId: 'u1' }),
      story({ id: 's2', status: 'ready-for-dev', assigneeId: null }),
      story({ id: 's3', status: 'ready-for-dev', assigneeId: null }),
      story({ id: 's4', status: 'backlog', assigneeId: 'u1' }),
      story({ id: 's5', status: 'backlog', assigneeId: null }),
      story({ id: 's6', status: 'in-progress' }), // ignored — neither ready-for-dev nor backlog
    ], 7);
    expect(stats).toEqual({ canDo: 1, unowned: 2, blocked: 7, backlogTotal: 2, backlogOwned: 1 });
  });

  it('empty input → all zero except the injected blocked count', () => {
    expect(deriveZeroStageStats([], 0)).toEqual({ canDo: 0, unowned: 0, blocked: 0, backlogTotal: 0, backlogOwned: 0 });
  });
});
