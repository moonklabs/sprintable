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

export const VALID_TRANSITIONS: Record<string, string[]> = {
  backlog: ['ready-for-dev'],
  'ready-for-dev': ['in-progress', 'backlog'],
  'in-progress': ['in-review', 'ready-for-dev'],
  'in-review': ['done', 'in-progress'],
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
