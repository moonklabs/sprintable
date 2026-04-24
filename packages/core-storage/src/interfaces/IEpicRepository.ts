import type { PaginationOptions } from '../types';

export interface RepositoryScopeContext {
  org_id?: string;
  project_id?: string;
}

export interface Epic {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  objective: string | null;
  success_criteria: string | null;
  target_sp: number | null;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateEpicInput {
  project_id: string;
  org_id: string;
  title: string;
  status?: string;
  priority?: string;
  description?: string | null;
  objective?: string | null;
  success_criteria?: string | null;
  target_sp?: number | null;
  target_date?: string | null;
}

export interface UpdateEpicInput {
  title?: string;
  status?: string;
  priority?: string;
  description?: string | null;
  objective?: string | null;
  success_criteria?: string | null;
  target_sp?: number | null;
  target_date?: string | null;
}

export interface EpicListFilters extends PaginationOptions {
  project_id?: string;
}

export interface IEpicRepository {
  create(input: CreateEpicInput): Promise<Epic>;
  list(filters: EpicListFilters): Promise<Epic[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Epic>;
  getByIdWithStories(id: string, scope?: RepositoryScopeContext): Promise<Epic & { stories: unknown[] }>;
  update(id: string, input: UpdateEpicInput): Promise<Epic>;
  delete(id: string, orgId: string): Promise<void>;
}
