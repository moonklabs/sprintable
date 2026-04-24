export interface KanbanStory {
  id: string;
  title: string;
  status: string;
  priority: string;
  story_points: number | null;
  assignee_id: string | null;
  epic_id: string | null;
  sprint_id: string | null;
  description: string | null;
}

export interface KanbanEpic {
  id: string;
  title: string;
}

export interface KanbanSprint {
  id: string;
  title: string;
  status: string;
}

export interface KanbanMember {
  id: string;
  name: string;
  type: string;
}

import { VALID_STORY_TRANSITIONS } from '@sprintable/shared';

// done→in-review는 admin만 허용 (백엔드 검증) — 프론트엔드에서는 done 드래그 허용 안 함
export const VALID_TRANSITIONS: Record<string, string[]> = {
  ...VALID_STORY_TRANSITIONS,
  done: [],
};

export const COLUMNS = [
  { id: 'backlog', i18nKey: 'backlog' },
  { id: 'ready-for-dev', i18nKey: 'readyForDev' },
  { id: 'in-progress', i18nKey: 'inProgress' },
  { id: 'in-review', i18nKey: 'inReview' },
  { id: 'done', i18nKey: 'done' },
] as const;

export type ColumnId = (typeof COLUMNS)[number]['id'];
