import { describe, expect, it } from 'vitest';
import {
  parseGoals, parseStories, parseNextUp, filterActiveGoals,
  deriveGoalStems, deriveRecentlyClosedEpicIds, sortStemsByStallUrgency,
  deriveHeadline, deriveZeroStageStats, deriveOrphanStories, deriveActiveLaneGoals,
  type NextMakerGoal, type NextMakerStory,
} from './derive-next-maker';

function goal(overrides: Partial<NextMakerGoal> = {}): NextMakerGoal {
  return { id: 'e1', title: 'Epic 1', status: 'active', totalStories: 10, doneStories: 2, ...overrides };
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
    expect(parseGoals([{ id: 'e1', title: 'T', status: 'active', total_stories: 5, done_stories: 2 }]))
      .toEqual([{ id: 'e1', title: 'T', status: 'active', totalStories: 5, doneStories: 2 }]);
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

describe('filterActiveGoals', () => {
  it('keeps only status=active, drops done/archived/draft', () => {
    const goals = [
      goal({ id: 'a', status: 'active' }),
      goal({ id: 'd', status: 'done' }),
      goal({ id: 'ar', status: 'archived' }),
      goal({ id: 'dr', status: 'draft' }),
    ];
    expect(filterActiveGoals(goals).map((g) => g.id)).toEqual(['a']);
  });

  it('empty input → empty output', () => {
    expect(filterActiveGoals([])).toEqual([]);
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

describe('deriveOrphanStories', () => {
  it('keeps only backlog stories with no epicId', () => {
    const result = deriveOrphanStories([
      story({ id: 'a', status: 'backlog', epicId: null }),
      story({ id: 'b', status: 'backlog', epicId: 'e1' }), // has an epic — excluded
      story({ id: 'c', status: 'ready-for-dev', epicId: null }), // not backlog — excluded
      story({ id: 'd', status: 'in-progress', epicId: null }), // not backlog — excluded
    ]);
    expect(result.map((s) => s.id)).toEqual(['a']);
  });

  it('sorts owned-first (PO: "주인 있는데 목표 없는 것이 제일 이상한 것")', () => {
    const result = deriveOrphanStories([
      story({ id: 'unowned1', status: 'backlog', epicId: null, assigneeId: null }),
      story({ id: 'owned1', status: 'backlog', epicId: null, assigneeId: 'u1' }),
      story({ id: 'unowned2', status: 'backlog', epicId: null, assigneeId: null }),
      story({ id: 'owned2', status: 'backlog', epicId: null, assigneeId: 'u2' }),
    ]);
    expect(result.map((s) => s.id)).toEqual(['owned1', 'owned2', 'unowned1', 'unowned2']);
  });

  it('does not mutate the input array', () => {
    const input = [story({ id: 'a', status: 'backlog', epicId: null })];
    const original = [...input];
    deriveOrphanStories(input);
    expect(input).toEqual(original);
  });

  it('empty input → empty output, no crash', () => {
    expect(deriveOrphanStories([])).toEqual([]);
  });
});

// story #2224 AC1(멀티레인) — 「레인이 몇 개까지 서는가」는 수가 아니라 성질(30일 안 변화)로
// 가른다. 스토리 0건은 이 함수에 아예 안 들어온다(호출부가 미리 거름) — expand/fold 둘 다
// «스토리가 있는» 목표만의 문제다.
describe('deriveActiveLaneGoals — dormancy 임계(호출부 전달, story #3126부터 BE 단일소스) 안 변화로 펼침/접힘을 가른다(story #2224 AC1)', () => {
  const NOW = new Date('2026-07-31T00:00:00Z').getTime();

  it('expands a goal whose most recent active story updated within the last 30 days', () => {
    const goals = [goal({ id: 'e1' })];
    const stories = [story({ epicId: 'e1', updatedAt: '2026-07-20T00:00:00Z' })]; // 11일 전
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    expect(result.expand.map((g) => g.id)).toEqual(['e1']);
    expect(result.fold).toEqual([]);
  });

  it('folds a goal whose most recent active story updated more than 30 days ago', () => {
    const goals = [goal({ id: 'e1' })];
    const stories = [story({ epicId: 'e1', updatedAt: '2026-06-01T00:00:00Z' })]; // 60일 전
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    expect(result.fold.map((g) => g.id)).toEqual(['e1']);
    expect(result.expand).toEqual([]);
  });

  it('folds a goal with NO active stories at all (can\'t prove "recent" — does not guess)', () => {
    const goals = [goal({ id: 'e1' })];
    const result = deriveActiveLaneGoals(goals, [], 720, NOW);
    expect(result.fold.map((g) => g.id)).toEqual(['e1']);
    expect(result.expand).toEqual([]);
  });

  it('uses the MOST RECENT of several active stories in the same goal — one old story does not fold a goal with a recent one', () => {
    const goals = [goal({ id: 'e1' })];
    const stories = [
      story({ id: 's-old', epicId: 'e1', updatedAt: '2026-01-01T00:00:00Z' }),
      story({ id: 's-new', epicId: 'e1', updatedAt: '2026-07-25T00:00:00Z' }), // 6일 전
    ];
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    expect(result.expand.map((g) => g.id)).toEqual(['e1']);
  });

  it('exactly at the 30-day boundary is still "expand" (<=, not <)', () => {
    const goals = [goal({ id: 'e1' })];
    const thirtyDaysAgo = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stories = [story({ epicId: 'e1', updatedAt: thirtyDaysAgo })];
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    expect(result.expand.map((g) => g.id)).toEqual(['e1']);
  });

  it('ignores stories belonging to a different epic', () => {
    const goals = [goal({ id: 'e1' }), goal({ id: 'e2' })];
    const stories = [story({ epicId: 'e2', updatedAt: '2026-07-30T00:00:00Z' })];
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    expect(result.expand.map((g) => g.id)).toEqual(['e2']);
    expect(result.fold.map((g) => g.id)).toEqual(['e1']);
  });

  it('every input goal ends up in exactly one of expand/fold (no goal dropped, no duplicate)', () => {
    const goals = [goal({ id: 'e1' }), goal({ id: 'e2' }), goal({ id: 'e3' })];
    const stories = [story({ epicId: 'e2', updatedAt: '2026-07-30T00:00:00Z' })];
    const result = deriveActiveLaneGoals(goals, stories, 720, NOW);
    const all = [...result.expand, ...result.fold].map((g) => g.id).sort();
    expect(all).toEqual(['e1', 'e2', 'e3']);
  });

  it('story #3126 — the caller-supplied dormancyThresholdHours is genuinely load-bearing(hardcoded 30일 잔존 0 검산): the same 11-day-old story expands under 720h(30일) but folds under a much narrower 24h', () => {
    const goals = [goal({ id: 'e1' })];
    const stories = [story({ epicId: 'e1', updatedAt: '2026-07-20T00:00:00Z' })]; // 11일 전
    expect(deriveActiveLaneGoals(goals, stories, 720, NOW).expand.map((g) => g.id)).toEqual(['e1']);
    expect(deriveActiveLaneGoals(goals, stories, 24, NOW).fold.map((g) => g.id)).toEqual(['e1']);
  });
});

// story #3126(페드루 조건, 2026-08-27 09:25) — «존치를 승인하되 조용히 갈라지지 못하게».
// deriveActiveLaneGoals의 lastActiveByEpic 로컬 계산(activeStories로부터)과 BE
// `GoalRepository.attach_glance_aggregates`의 latest_story_activity_at 공식이 같은
// 정의(non-done story의 updated_at 최댓값)·같은 비교연산자(<=, 초과가 아니라 이상 포함)를
// 지켜야 한다. 여기 오라클은 소스코드(deriveActiveLaneGoals 내부 Map 루프)와 «다른 방식»으로
// 같은 규칙을 재구현한다(reduce 체인) — 소스와 같은 스타일로 베끼면 로직 버그가 그대로
// 복제돼도 이 테스트가 못 잡는다.
describe('deriveActiveLaneGoals — BE 공식(non-done MAX·<=) 등가 pin(story #3126, 페드루 조건)', () => {
  const NOW = new Date('2026-07-31T00:00:00Z').getTime();

  // BE app/repositories/goal.py::attach_glance_aggregates의 latest_story_activity_at
  // 정의를 독립 재구현(SELECT MAX(updated_at) WHERE status != 'done' GROUP BY epic_id) —
  // 소스(deriveActiveLaneGoals)와 다른 스타일(reduce)로 짜서 같은 버그를 복제하지 않는다.
  function beFormulaOracle(
    goals: NextMakerGoal[],
    stories: NextMakerStory[],
    dormancyThresholdHours: number,
    now: number,
  ): { expand: string[]; fold: string[] } {
    const nonDone = stories.filter((s) => s.status !== 'done' && s.epicId != null);
    const latestByEpic = nonDone.reduce<Record<string, number>>((acc, s) => {
      const t = new Date(s.updatedAt).getTime();
      if (Number.isNaN(t)) return acc;
      const cur = acc[s.epicId as string];
      acc[s.epicId as string] = cur === undefined ? t : Math.max(cur, t);
      return acc;
    }, {});
    const thresholdMs = dormancyThresholdHours * 3600_000;
    const expand: string[] = [];
    const fold: string[] = [];
    for (const g of goals) {
      const latest = latestByEpic[g.id];
      if (latest !== undefined && now - latest <= thresholdMs) expand.push(g.id);
      else fold.push(g.id);
    }
    return { expand, fold };
  }

  it.each([
    { name: '단일 non-done story, 임계 안', hours: 720, stories: [story({ epicId: 'e1', status: 'in-progress', updatedAt: '2026-07-20T00:00:00Z' })] },
    { name: '단일 non-done story, 임계 밖', hours: 24, stories: [story({ epicId: 'e1', status: 'in-progress', updatedAt: '2026-07-20T00:00:00Z' })] },
    { name: 'done story만 있음(제외되어 latest 없음)', hours: 720, stories: [story({ epicId: 'e1', status: 'done', updatedAt: '2026-07-30T23:00:00Z' })] },
    {
      name: 'done+non-done 혼재 — done의 더 최근 값이 안 섞인다',
      hours: 720,
      stories: [
        story({ id: 's-done', epicId: 'e1', status: 'done', updatedAt: '2026-07-30T23:00:00Z' }),
        story({ id: 's-old', epicId: 'e1', status: 'backlog', updatedAt: '2026-01-01T00:00:00Z' }),
      ],
    },
    {
      name: '경계값(정확히 임계) — <=라 expand',
      hours: 720,
      stories: [story({ epicId: 'e1', status: 'ready-for-dev', updatedAt: new Date(NOW - 720 * 3600_000).toISOString() })],
    },
    { name: '스토리 0건(latest 자체가 없음)', hours: 720, stories: [] },
  ])('$name', ({ hours, stories }) => {
    const goals = [goal({ id: 'e1' })];
    const actual = deriveActiveLaneGoals(goals, stories, hours, NOW);
    const expected = beFormulaOracle(goals, stories, hours, NOW);
    expect(actual.expand.map((g) => g.id)).toEqual(expected.expand);
    expect(actual.fold.map((g) => g.id)).toEqual(expected.fold);
  });
});
