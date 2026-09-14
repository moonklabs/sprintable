import { describe, expect, it } from 'vitest';
import { EMPTY_WORK_LIST_FILTERS, filterWorkList, type WorkListFilters } from './filter-work-list';
import type { WorkList } from './derive-work-list';

function baseRow(overrides: Partial<WorkList['groups'][number]['stories'][number]['rows'][number]> = {}) {
  return {
    id: 'r1', kind: 'task' as const, workItemType: 'task' as const, workItemId: 'r1',
    title: '할일1', ownerName: null, isDelegated: false, lowRisk: false, hasArtifacts: false, state: null,
    ...overrides,
  };
}

function baseWorkList(): WorkList {
  return {
    partial: false,
    groups: [
      {
        goalId: 'g1', title: '목표1', doneCount: 0, totalCount: 2, assignedCount: 1, delegatedCount: 1, hypothesisCount: 1,
        stories: [
          { storyId: 's1', title: '스토리1', hypothesisIds: ['h1'], rows: [baseRow({ id: 't1', isDelegated: false }), baseRow({ id: 't2', isDelegated: true })] },
        ],
      },
      {
        goalId: 'g2', title: '목표2', doneCount: 0, totalCount: 1, assignedCount: 1, delegatedCount: 0, hypothesisCount: 0,
        stories: [
          { storyId: 's2', title: '스토리2', hypothesisIds: [], rows: [baseRow({ id: 't3', isDelegated: false })] },
        ],
      },
    ],
  };
}

function filters(overrides: Partial<WorkListFilters> = {}): WorkListFilters {
  return { ...EMPTY_WORK_LIST_FILTERS, ...overrides };
}

describe('filterWorkList', () => {
  it('빈 필터는 원본 그대로(구조만 새로 만든다)', () => {
    const result = filterWorkList(baseWorkList(), filters());
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].stories[0].rows).toHaveLength(2);
  });

  it('goalId 필터 — 그 목표만 남는다', () => {
    const result = filterWorkList(baseWorkList(), filters({ goalId: 'g2' }));
    expect(result.groups.map((g) => g.goalId)).toEqual(['g2']);
  });

  it('hypothesisId 필터 — hypothesisIds에 없는 스토리는 걷어낸다(빈 goal도 함께)', () => {
    const result = filterWorkList(baseWorkList(), filters({ hypothesisId: 'h1' }));
    expect(result.groups.map((g) => g.goalId)).toEqual(['g1']); // g2(스토리2)는 h1 연결 없어 사라짐
  });

  it('mineOnly — isDelegated=true 행은 숨긴다', () => {
    const result = filterWorkList(baseWorkList(), filters({ mineOnly: true }));
    expect(result.groups[0].stories[0].rows.map((r) => r.id)).toEqual(['t1']);
  });

  it('delegatedOnly — isDelegated=false 행은 숨긴다', () => {
    const result = filterWorkList(baseWorkList(), filters({ delegatedOnly: true }));
    expect(result.groups[0].stories[0].rows.map((r) => r.id)).toEqual(['t2']);
    expect(result.groups.map((g) => g.goalId)).toEqual(['g1']); // g2(t3, isDelegated=false)는 사라짐
  });

  it('필터로 스토리가 0개가 된 목표는 결과에서 빠진다', () => {
    const result = filterWorkList(baseWorkList(), filters({ goalId: 'g1', hypothesisId: 'h-nonexistent' }));
    expect(result.groups).toHaveLength(0); // g1의 유일한 스토리(s1)가 hypothesisId 불일치로 걸러져 목표째 사라짐
  });

  it('partial 플래그는 원본 값을 그대로 보존한다', () => {
    const wl = baseWorkList();
    wl.partial = true;
    const result = filterWorkList(wl, filters());
    expect(result.partial).toBe(true);
  });
});
