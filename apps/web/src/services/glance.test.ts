import { describe, expect, it } from 'vitest';
import {
  deriveCollaboration,
  deriveRoadmapStatus,
  derivePhrase,
  filterMilestoneEvents,
  mergeRoadmap,
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
