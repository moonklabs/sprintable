import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Doc {
  id: string;
  org_id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  content: string | null;
  content_format: 'markdown' | 'html';
  icon: string | null;
  tags: string[] | null;
  sort_order: number;
  is_folder: boolean;
  doc_type: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocSummary {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_folder: boolean;
  updated_at: string;
}

export interface CreateDocInput {
  org_id: string;
  project_id: string;
  title: string;
  slug: string;
  content?: string;
  content_format?: 'markdown' | 'html';
  icon?: string | null;
  tags?: string[];
  parent_id?: string | null;
  is_folder?: boolean;
  sort_order?: number;
  doc_type?: string;
  created_by: string;
}

export interface UpdateDocInput {
  title?: string;
  content?: string;
  content_format?: 'markdown' | 'html';
  icon?: string | null;
  tags?: string[];
  sort_order?: number;
  parent_id?: string | null;
}

export interface DocListFilters extends PaginationOptions {
  project_id: string;
}

export interface IDocRepository {
  list(filters: DocListFilters): Promise<DocSummary[]>;
  getTree(projectId: string): Promise<DocSummary[]>;
  getBySlug(projectId: string, slug: string): Promise<Doc>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Doc>;
  create(input: CreateDocInput): Promise<Doc>;
  update(id: string, input: UpdateDocInput): Promise<Doc>;
  delete(id: string, orgId: string): Promise<void>;
}
