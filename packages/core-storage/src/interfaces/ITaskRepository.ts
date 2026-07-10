import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Task {
  id: string;
  org_id: string;
  story_id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  story_points: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // E-VERIFY V0-S1/S2: 실증-done 신뢰 신호(story와 동일 계약). V0-S3 FE 표면은 story 카드/상세
  // 한정(design doc §9 scope) — task 표면은 후속 스토리 판단.
  has_evidence?: boolean | null;
}

export interface CreateTaskInput {
  story_id: string;
  title: string;
  assignee_id?: string | null;
  status?: string;
}

export interface UpdateTaskInput {
  title?: string;
  status?: string;
  assignee_id?: string | null;
}

export interface TaskListFilters extends PaginationOptions {
  story_id?: string;
  project_id?: string;
  assignee_id?: string;
  status?: string;
  status_ne?: string;
  days_since?: number;
}

export interface ITaskRepository {
  create(input: CreateTaskInput): Promise<Task>;
  list(filters: TaskListFilters): Promise<Task[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Task>;
  update(id: string, input: UpdateTaskInput): Promise<Task>;
  delete(id: string, orgId: string): Promise<void>;
}
