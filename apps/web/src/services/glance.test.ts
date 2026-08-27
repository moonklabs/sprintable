import { describe, expect, it } from 'vitest';
import {
  deriveRoadmapStatus,
  derivePhrase,
  mergeRoadmap,
  scopeRoadmapEpics,
  type BeEpicListItem,
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
    const ts = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    return { id, title: id, status, created_at: ts, updated_at: ts };
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
    const ts = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`;
    return { id, title: id, status, created_at: ts, updated_at: ts, position };
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
    { id: 'e1', title: 'E-VERIFY', status: 'done', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' },
    { id: 'e2', title: 'E-CANVAS', status: 'active', created_at: '2026-06-15T00:00:00Z', updated_at: '2026-06-15T00:00:00Z' },
    { id: 'e3', title: 'E-GLANCE', status: 'draft', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
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

// story #2224(선생님 정정 2026-07-30) — filterMilestoneEvents/deriveVagueRecency 테스트를
// 제거했다. 유일 소비처(LiveStream, §6 생동 스트림)가 /glance 삭제와 함께 죽은 코드가 됐고,
// 그 함수들 자체도 services/glance.ts에서 함께 삭제됐다(아래 참고).
