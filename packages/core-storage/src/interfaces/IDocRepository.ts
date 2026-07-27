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
  tags: string[] | null;
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
  tags?: string[];
  q?: string;
}

// story #2191(#2231 규약 A) — BE가 has_more/next_cursor를 body meta로 직접 계산해 낸다
// (limit+1 오버페치는 BE 내부에서 이미 끝남 — FE가 buildCursorPageMeta로 재추론하지 않는다).
// getTree()는 이 스토리에서 소거됨 — BE 라우터는 parent_id 유무로만 tree/list 분기하는데
// FE는 애초에 parent_id를 안 보내(project_id만) 항상 일반 list() 분기로 떨어지고 있었다
// ("tree 분기"라는 별도 경로가 실제로는 없었다) — list()로 완전히 통합한다.
export interface DocPageResult {
  items: DocSummary[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface IDocRepository {
  list(filters: DocListFilters): Promise<DocPageResult>;
  getBySlug(projectId: string, slug: string): Promise<Doc>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Doc>;
  create(input: CreateDocInput): Promise<Doc>;
  update(id: string, input: UpdateDocInput): Promise<Doc>;
  delete(id: string, orgId: string): Promise<void>;
}
