import type { WorkList, WorkListGoalGroup, WorkListRow, WorkListStoryGroup } from './derive-work-list';

/**
 * story #3844 — URL 쿼리 4필터(goal·hypothesis·mine·delegated, PO 確定 낱말). deriveWorkList와
 * 분리된 별도 순수함수 — 그룹핑/상태 판정(도메인 규칙)과 "지금 무엇을 숨기는가"(뷰 관심사)를
 * 한 함수에 섞지 않는다. 빈 스토리/goal이 된 그룹은 걷어낸다(deriveWorkList의 "일 0개 goal은
 * 안 그린다" 규칙과 동형 — 필터 적용 후에도 같은 규칙 유지).
 */
export interface WorkListFilters {
  goalId: string | null;
  hypothesisId: string | null;
  mineOnly: boolean;
  delegatedOnly: boolean;
}

export const EMPTY_WORK_LIST_FILTERS: WorkListFilters = {
  goalId: null,
  hypothesisId: null,
  mineOnly: false,
  delegatedOnly: false,
};

function rowMatches(row: WorkListRow, filters: WorkListFilters): boolean {
  if (filters.mineOnly && row.isDelegated) return false;
  if (filters.delegatedOnly && !row.isDelegated) return false;
  return true;
}

function storyMatches(story: WorkListStoryGroup, filters: WorkListFilters): boolean {
  if (filters.hypothesisId && !story.hypothesisIds.includes(filters.hypothesisId)) return false;
  return true;
}

export function filterWorkList(workList: WorkList, filters: WorkListFilters): WorkList {
  const groups: WorkListGoalGroup[] = [];
  for (const goal of workList.groups) {
    if (filters.goalId && goal.goalId !== filters.goalId) continue;

    const stories: WorkListStoryGroup[] = [];
    for (const story of goal.stories) {
      if (!storyMatches(story, filters)) continue;
      const rows = story.rows.filter((row) => rowMatches(row, filters));
      if (rows.length === 0) continue;
      stories.push({ ...story, rows });
    }
    if (stories.length === 0) continue;
    groups.push({ ...goal, stories });
  }
  return { groups, partial: workList.partial };
}
