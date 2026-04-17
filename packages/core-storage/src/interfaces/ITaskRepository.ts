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
}

export interface CreateTaskInput {
  story_id: string;
  title: string;
  assignee_id?: string | null;
  status?: string;
  story_points?: number | null;
}

export interface UpdateTaskInput {
  title?: string;
  status?: string;
  assignee_id?: string | null;
  story_points?: number | null;
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
