import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Sprint {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  start_date: string;
  end_date: string;
  team_size: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSprintInput {
  project_id: string;
  org_id: string;
  title: string;
  start_date: string;
  end_date: string;
  team_size?: number;
}

export interface UpdateSprintInput {
  title?: string;
  start_date?: string;
  end_date?: string;
  team_size?: number;
  status?: string;
}

export interface SprintListFilters extends PaginationOptions {
  project_id?: string;
  status?: string;
}

export interface ISprintRepository {
  create(input: CreateSprintInput): Promise<Sprint>;
  list(filters: SprintListFilters): Promise<Sprint[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Sprint>;
  update(id: string, input: UpdateSprintInput): Promise<Sprint>;
  delete(id: string, orgId: string): Promise<void>;
}
