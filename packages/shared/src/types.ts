/**
 * 공유 도메인 타입
 */

export type StoryStatus =
  | 'backlog'
  | 'ready-for-dev'
  | 'in-progress'
  | 'in-review'
  | 'done';

export interface Sprint {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  goal: string;
}

export interface Story {
  id: number;
  title: string;
  status: StoryStatus;
  assignee: string | null;
  sprintId: string;
  storyPoints: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: number;
  storyId: number;
  title: string;
  assignee: string | null;
  isDone: boolean;
}
