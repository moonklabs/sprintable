import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Project {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  org_id: string;
  name: string;
  description?: string | null;
  created_by?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}

export interface ProjectListFilters extends PaginationOptions {
  org_id: string;
}

export interface IProjectRepository {
  list(filters: ProjectListFilters): Promise<Project[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Project>;
  create(input: CreateProjectInput): Promise<Project>;
  update(id: string, input: UpdateProjectInput): Promise<Project>;
  delete(id: string, orgId: string): Promise<void>;
}
