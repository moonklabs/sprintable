import { describe, expect, it } from 'vitest';
import {
  deriveCollaboration,
  deriveRoadmapStatus,
  deriveVagueRecency,
  derivePhrase,
  filterMilestoneEvents,
  mergeRoadmap,
  scopeRoadmapEpics,
  type BeActivityLogItem,
  type BeEpicListItem,
  type BeStoryListItem,
} from './glance';
import type { EpicProgress } from '@/components/dashboard/command-center/types';

describe('deriveRoadmapStatus (epic.status → 3버킷, done/archived 통합)', () => {
  it('maps done and archived to done', () => {
    expect(deriveRoadmapStatus('done')).toBe('done');
    expect(deriveRoadmapStatus('archived')).toBe('done');
  });
  it('maps active to active', () => {
    expect(deriveRoadmapStatus('active')).toBe('active');
  });
  it('maps draft and any unknown value to upcoming (safe fallback)', () => {
    expect(deriveRoadmapStatus('draft')).toBe('upcoming');
    expect(deriveRoadmapStatus('something-unexpected')).toBe('upcoming');
  });
});

describe('scopeRoadmapEpics ("현재 궤적" window — 유나 서사 확定(b), active(들)를 anchor로 앞뒤 소수만)', () => {
  function epicAt(id: string, status: string, day: number): BeEpicListItem {
    return { id, title: id, status, created_at: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` };
  }

  it('anchors on the single active epic and takes `behind` done epics before it, `ahead` upcoming after', () => {
    const epics = [
      epicAt('d1', 'done', 1), epicAt('d2', 'done', 2), epicAt('d3', 'done', 3),
      epicAt('active', 'active', 4),
      epicAt('u1', 'draft', 5), epicAt('u2', 'draft', 6), epicAt('u3', 'draft', 7),
    ];
    const arc = scopeRoadmapEpics(epics, { behind: 2, ahead: 2, bound: 8 });
    expect(arc.epics.map((e) => e.id)).toEqual(['d2', 'd3', 'active', 'u1', 'u2']);
    expect(arc.totalCount).toBe(7);
  });

  it('treats multiple simultaneous active epics as one cluster (anchor spans all of them)', () => {
    const epics = [
      epicAt('d1', 'done', 1),
      epicAt('a1', 'active', 2), epicAt('a2', 'active', 3), epicAt('a3', 'active', 4),
      epicAt('u1', 'draft', 5),
    ];
    const arc = scopeRoadmapEpics(epics, { behind: 1, ahead: 1, bound: 8 });
    expect(arc.epics.map((e) => e.id)).toEqual(['d1', 'a1', 'a2', 'a3', 'u1']);
  });

  it('falls back to the done→draft boundary as the anchor when there is no active epic at all', () => {
    const epics = [
      epicAt('d1', 'done', 1), epicAt('d2', 'done', 2),
      epicAt('u1', 'draft', 3), epicAt('u2', 'draft', 4),
    ];
    const arc = scopeRoadmapEpics(epics, { behind: 1, ahead: 1, bound: 8 });
    expect(arc.epics.map((e) => e.id)).toEqual(['d2', 'u1']);
  });

  it('hard-caps the window to `bound` even if behind+active+ahead would exceed it', () => {
    const epics = Array.from({ length: 6 }, (_, i) => epicAt(`a${i}`, 'active', i + 1));
    const arc = scopeRoadmapEpics(epics, { behind: 2, ahead: 2, bound: 4 });
    expect(arc.epics).toHaveLength(4);
  });

  it('returns everything (chronological order) when the whole project fits inside the window', () => {
    const epics = [epicAt('a', 'done', 1), epicAt('b', 'active', 2)];
    const arc = scopeRoadmapEpics(epics, { behind: 2, ahead: 2, bound: 8 });
    expect(arc.epics.map((e) => e.id)).toEqual(['a', 'b']);
    expect(arc.totalCount).toBe(2);
  });

  it('biases the bound cutoff toward the newest epics, not the oldest, when the active cluster itself is wider than bound (라이브 픽셀 2026-07-11 적출 — 200에픽/active44 실 데이터에서 old8개만 잡히던 버그)', () => {
    // 100 epics ascending by created_at: idx 0-29 done, idx 30-99 active (mirrors the real
    // project's "org never closes epics" shape reported live — active spans most of the array).
    const epics = [
      ...Array.from({ length: 30 }, (_, i) => epicAt(`d${i}`, 'done', i)),
      ...Array.from({ length: 70 }, (_, i) => epicAt(`a${30 + i}`, 'active', 30 + i)),
    ];
    const arc = scopeRoadmapEpics(epics, { behind: 2, ahead: 2, bound: 8 });
    // Old (buggy) behavior would take the OLDEST 8 of the [28,100) window → 'd28','d29','a30'..'a35'.
    // Fixed behavior takes the NEWEST 8 — the tail closest to "now"/forward.
    expect(arc.epics.map((e) => e.id)).toEqual(['a92', 'a93', 'a94', 'a95', 'a96', 'a97', 'a98', 'a99']);
    expect(arc.totalCount).toBe(100);
  });
});

describe('scopeRoadmapEpics — 로드맵 조타 curated-first 소비(wedge #2·position 반영·#2056 회귀0)', () => {
  function epic(id: string, status: string, day: number, position?: number | null): BeEpicListItem {
    return { id, title: id, status, created_at: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, position };
  }

  it('position 전무(미조타) 시 created_at ASC 폴백 — 기존 렌더와 동일(#2056 회귀0)', () => {
    const epics = [epic('c', 'active', 3), epic('a', 'done', 1), epic('b', 'done', 2)];
    const arc = scopeRoadmapEpics(epics, { behind: 5, ahead: 5, bound: 8 });
    expect(arc.epics.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('큐레이션(position≠null)을 position ASC로 앞에 고정, 나머지 null은 created_at ASC로 뒤에', () => {
    const epics = [
      epic('auto-old', 'active', 1),   // null → tail(created_at ASC)
      epic('auto-new', 'draft', 9),    // null → tail
      epic('cur-2', 'done', 5, 2),     // 큐레이션 2
      epic('cur-1', 'draft', 8, 1),    // 큐레이션 1(가장 앞)
    ];
    const arc = scopeRoadmapEpics(epics, { behind: 9, ahead: 9, bound: 20 });
    expect(arc.epics.map((e) => e.id)).toEqual(['cur-1', 'cur-2', 'auto-old', 'auto-new']);
  });
});

describe('mergeRoadmap (epic 목록 순서 SSOT + 별도 진척 엔드포인트 병합)', () => {
  const epics: BeEpicListItem[] = [
    { id: 'e1', title: 'E-VERIFY', status: 'done', created_at: '2026-06-01T00:00:00Z' },
    { id: 'e2', title: 'E-CANVAS', status: 'active', created_at: '2026-06-15T00:00:00Z' },
    { id: 'e3', title: 'E-GLANCE', status: 'draft', created_at: '2026-07-01T00:00:00Z' },
  ];

  it('preserves the epic list order and merges progress by epic_id', () => {
    const progress: EpicProgress[] = [
      { epic_id: 'e2', title: 'E-CANVAS', status: 'active', total: 8, done: 5, completion_pct: 62 },
    ];
    const roadmap = mergeRoadmap(epics, progress);
    expect(roadmap.map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
    expect(roadmap[1]).toMatchObject({ done: 5, total: 8, completionPct: 62, roadmapStatus: 'active' });
  });

  it('falls back to 0/0 (calm "시작 전", not a deficiency) when progress data is missing for an epic', () => {
    const roadmap = mergeRoadmap(epics, []);
    expect(roadmap[2]).toMatchObject({ done: 0, total: 0, completionPct: 0, roadmapStatus: 'upcoming' });
  });
});

describe('derivePhrase (정성 진척 언어 — %는 보조)', () => {
  it('returns notStarted for a zero-story epic', () => {
    expect(derivePhrase(0, 0)).toBe('notStarted');
  });
  it('returns notStarted for 0% even with stories present', () => {
    expect(derivePhrase(0, 5)).toBe('notStarted');
  });
  it('buckets mid-range progress as underway', () => {
    expect(derivePhrase(45, 10)).toBe('underway');
  });
  it('buckets high progress as almostThere', () => {
    expect(derivePhrase(75, 8)).toBe('almostThere');
  });
  it('buckets near-complete progress as wrappingUp', () => {
    expect(derivePhrase(95, 20)).toBe('wrappingUp');
  });
});

describe('deriveCollaboration (참여=presence만, 개수 집계 0)', () => {
  const stories: BeStoryListItem[] = [
    { id: 's1', epic_id: 'e1', assignee_id: 'm1' },
    { id: 's2', epic_id: 'e1', assignee_id: 'm1' }, // 같은 사람 중복 스토리 — collaborator는 1명이어야
    { id: 's3', epic_id: 'e1', assignee_id: 'm2' },
    { id: 's4', epic_id: 'e2', assignee_id: null }, // 미배정
  ];
  const memberNames = { m1: '미르코 페트로비치', m2: '유나 홀름' };

  it('dedupes repeated assignees on the same epic into a single presence entry', () => {
    const [e1] = deriveCollaboration(['e1'], stories, memberNames);
    expect(e1!.collaborators).toHaveLength(2);
    expect(e1!.collaborators.map((c) => c.name).sort()).toEqual(['미르코 페트로비치', '유나 홀름']);
  });

  it('returns an empty collaborator list (not a crash) when no story is assigned', () => {
    const [e2] = deriveCollaboration(['e2'], stories, memberNames);
    expect(e2!.collaborators).toEqual([]);
  });

  it('returns an empty collaborator list for an epic with no stories at all', () => {
    const [e3] = deriveCollaboration(['e3'], stories, memberNames);
    expect(e3!.collaborators).toEqual([]);
  });
});

describe('filterMilestoneEvents ("누가"가 아닌 "무슨 일" — 허용목록 기반)', () => {
  const base = { id: 'a1', actor_type: 'agent' as const, entity_type: 'story', entity_title: 'X', created_at: '2026-07-10T00:00:00Z' };

  it('keeps known milestone actions', () => {
    const items: BeActivityLogItem[] = [{ ...base, action: 'story.status_changed' }];
    expect(filterMilestoneEvents(items)).toHaveLength(1);
  });

  it('drops unknown/noise actions (e.g. raw keystroke or heartbeat events)', () => {
    const items: BeActivityLogItem[] = [{ ...base, action: 'agent.heartbeat' }];
    expect(filterMilestoneEvents(items)).toHaveLength(0);
  });
});

describe('deriveVagueRecency (목업 §④ 성긴 버킷 — 분 단위 정밀 경과 표시 0)', () => {
  const NOW = new Date('2026-07-10T12:00:00Z').getTime();

  it('buckets under 5 minutes as justNow', () => {
    expect(deriveVagueRecency(NOW - 2 * 60_000, NOW)).toBe('justNow');
  });
  it('buckets under 1 hour (but over 5 min) as aWhileAgo', () => {
    expect(deriveVagueRecency(NOW - 30 * 60_000, NOW)).toBe('aWhileAgo');
  });
  it('buckets under 24 hours (but over 1 hour) as today', () => {
    expect(deriveVagueRecency(NOW - 5 * 60 * 60_000, NOW)).toBe('today');
  });
  it('buckets 24+ hours as earlier', () => {
    expect(deriveVagueRecency(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('earlier');
  });
});
