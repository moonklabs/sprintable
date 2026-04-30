import type { SupabaseClient } from '@supabase/supabase-js';
import type { IDocRepository, Doc, DocSummary, CreateDocInput, UpdateDocInput, DocListFilters, RepositoryScopeContext } from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { fastapiCall, mapSupabaseError } from './utils';

export class SupabaseDocRepository implements IDocRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async list(filters: DocListFilters): Promise<DocSummary[]> {
    if (this.fastapi) return fastapiCall<DocSummary[]>('GET', '/api/v2/docs', this.accessToken, { query: { project_id: filters.project_id } });
    let query = this.supabase.from('docs').select('id, parent_id, title, slug, icon, tags, sort_order, is_folder, updated_at').eq('project_id', filters.project_id).is('deleted_at', null).order('updated_at', { ascending: false });
    if (filters.cursor) query = query.lt('updated_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as DocSummary[];
  }

  async getTree(projectId: string): Promise<DocSummary[]> {
    if (this.fastapi) return fastapiCall<DocSummary[]>('GET', '/api/v2/docs', this.accessToken, { query: { project_id: projectId } });
    const { data, error } = await this.supabase.from('docs').select('id, parent_id, title, slug, icon, tags, sort_order, is_folder, updated_at').eq('project_id', projectId).is('deleted_at', null).order('sort_order');
    if (error) throw error;
    return (data ?? []) as DocSummary[];
  }

  async getBySlug(projectId: string, slug: string): Promise<Doc> {
    if (this.fastapi) {
      const docs = await fastapiCall<Doc[]>('GET', '/api/v2/docs', this.accessToken, { query: { project_id: projectId } });
      const found = docs.find((d: Doc) => (d as unknown as { slug?: string }).slug === slug);
      if (!found) throw new Error(`Doc not found: ${slug}`);
      return found;
    }
    const { data, error } = await this.supabase.from('docs').select('*').eq('project_id', projectId).eq('slug', slug).is('deleted_at', null).single();
    if (error) throw mapSupabaseError(error);
    return data as Doc;
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Doc> {
    if (this.fastapi) return fastapiCall<Doc>('GET', `/api/v2/docs/${id}`, this.accessToken);
    let query = this.supabase.from('docs').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    if (scope?.project_id) query = query.eq('project_id', scope.project_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Doc;
  }

  async create(input: CreateDocInput): Promise<Doc> {
    if (this.fastapi) return fastapiCall<Doc>('POST', '/api/v2/docs', this.accessToken, { body: input, orgId: input.org_id });
    const { data, error } = await this.supabase.from('docs').insert({ org_id: input.org_id, project_id: input.project_id, parent_id: input.parent_id ?? null, title: input.title, slug: input.slug, content: input.content ?? null, content_format: input.content_format ?? 'markdown', icon: input.icon ?? null, tags: input.tags ?? [], sort_order: input.sort_order ?? 0, is_folder: input.is_folder ?? false, doc_type: input.doc_type ?? 'page', created_by: input.created_by }).select().single();
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
    return data as Doc;
  }

  async update(id: string, input: UpdateDocInput): Promise<Doc> {
    if (this.fastapi) return fastapiCall<Doc>('PATCH', `/api/v2/docs/${id}`, this.accessToken, { body: input });
    const ALLOWED: (keyof UpdateDocInput)[] = ['title', 'content', 'content_format', 'icon', 'tags', 'sort_order', 'parent_id'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) { if (key in input) patch[key] = input[key]; }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');
    const { data, error } = await this.supabase.from('docs').update(patch).eq('id', id).is('deleted_at', null).select().single();
    if (error) throw mapSupabaseError(error);
    return data as Doc;
  }

  async delete(id: string, _orgId: string): Promise<void> {
    if (this.fastapi) { await fastapiCall<void>('DELETE', `/api/v2/docs/${id}`, this.accessToken); return; }
    const { error } = await this.supabase.from('docs').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw error; }
  }
}
