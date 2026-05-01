import type { SupabaseClient } from '@supabase/supabase-js';
import type { IDocRepository, CreateDocInput, UpdateDocInput } from '@sprintable/core-storage';
import { SupabaseDocRepository } from '@sprintable/storage-supabase';

export class DocsService {
  private readonly repo: IDocRepository;
  private readonly supabase: SupabaseClient | null;

  constructor(repo: IDocRepository, supabase?: SupabaseClient) {
    this.repo = repo;
    this.supabase = supabase ?? null;
  }

  static fromSupabase(supabase: SupabaseClient): DocsService {
    return new DocsService(new SupabaseDocRepository(supabase), supabase);
  }

  async list(projectId: string, input?: { limit?: number; cursor?: string | null; tags?: string[] }) {
    return this.repo.list({ project_id: projectId, limit: input?.limit, cursor: input?.cursor ?? undefined, tags: input?.tags });
  }

  async getTree(projectId: string) {
    return this.repo.getTree(projectId);
  }

  async getDoc(projectId: string, slug: string) {
    return this.repo.getBySlug(projectId, slug);
  }

  async createDoc(input: CreateDocInput) {
    return this.repo.create(input);
  }

  async updateDoc(
    id: string,
    input: {
      title?: string;
      content?: string;
      content_format?: 'markdown' | 'html';
      icon?: string | null;
      tags?: string[];
      sort_order?: number;
      parent_id?: string | null;
      created_by?: string;
      expected_updated_at?: string;
      force_overwrite?: boolean;
    },
  ) {
    const { expected_updated_at, force_overwrite, created_by: _created_by, ...fields } = input;

    // AC4: parent_id가 UUID면 해당 폴더 존재 여부 검증 (Supabase + OSS 공통)
    if (fields.parent_id != null) {
      if (this.supabase) {
        const { data: parentDoc, error: parentErr } = await this.supabase
          .from('docs')
          .select('id, is_folder')
          .eq('id', fields.parent_id)
          .maybeSingle();
        if (parentErr) throw parentErr;
        if (!parentDoc) throw Object.assign(new Error(`Parent folder not found: ${fields.parent_id}`), { code: 'NOT_FOUND' });
        if (!parentDoc.is_folder) throw Object.assign(new Error(`Target is not a folder: ${fields.parent_id}`), { code: 'BAD_REQUEST' });
      } else {
        let parentDoc: { is_folder?: boolean } | null = null;
        try { parentDoc = await this.repo.getById(fields.parent_id); } catch { /* not found */ }
        if (!parentDoc) throw Object.assign(new Error(`Parent folder not found: ${fields.parent_id}`), { code: 'NOT_FOUND' });
        if (!parentDoc.is_folder) throw Object.assign(new Error(`Target is not a folder: ${fields.parent_id}`), { code: 'BAD_REQUEST' });
      }
    }

    if (this.supabase) {
      let query = this.supabase.from('docs').update(fields).eq('id', id);
      if (expected_updated_at && !force_overwrite) query = query.eq('updated_at', expected_updated_at);
      const { data, error } = await query.select().maybeSingle();
      if (error) throw error;

      if (!data) {
        if (expected_updated_at && !force_overwrite) {
          const { data: current, error: fetchErr } = await this.supabase.from('docs').select('updated_at').eq('id', id).single();
          if (fetchErr) throw fetchErr;
          const err = new Error('Document was modified by another user');
          (err as Error & { code?: string; server_updated_at?: string }).code = 'CONFLICT';
          (err as Error & { code?: string; server_updated_at?: string }).server_updated_at = current.updated_at;
          throw err;
        }
        throw new Error(`Document not found: ${id}`);
      }

      // 리비전은 DB 트리거(trg_docs_auto_revision)가 자동 생성
      if (fields.content !== undefined) {
        await this.supabase.rpc('trim_doc_revisions', { _doc_id: id, _keep: 50 });
      }
      return data;
    }

    return this.repo.update(id, fields as UpdateDocInput);
  }

  /** Fetch only updated_at for lightweight polling */
  async getDocTimestamp(id: string) {
    if (this.supabase) {
      const { data, error } = await this.supabase.from('docs').select('updated_at').eq('id', id).single();
      if (error) throw error;
      return data;
    }
    const doc = await this.repo.getById(id);
    return { updated_at: doc.updated_at };
  }

  async getRevisions(docId: string) {
    if (!this.supabase) return [];
    const { data, error } = await this.supabase.from('doc_revisions').select('*').eq('doc_id', docId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async getComments(docId: string) {
    if (!this.supabase) return [];
    const { data, error } = await this.supabase.from('doc_comments').select('*').eq('doc_id', docId).order('created_at');
    if (error) throw error;
    return data;
  }

  async addComment(input: { doc_id: string; content: string; created_by: string }) {
    if (!this.supabase) throw new Error('Comments not supported in OSS mode');
    const { data, error } = await this.supabase.from('doc_comments').insert(input).select().single();
    if (error) throw error;
    return data;
  }

  async deleteDoc(id: string) {
    if (this.supabase) {
      const { error } = await this.supabase.from('docs').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      return;
    }
    await this.repo.delete(id, '');
  }

  /** Fetch preview fields (id, title, icon, slug, content) by UUID or slug */
  async getDocPreview(projectId: string, q: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    if (this.supabase) {
      let builder = this.supabase.from('docs').select('id, title, icon, slug, content').eq('project_id', projectId);
      builder = isUuid ? builder.eq('id', q) : builder.eq('slug', q);
      const { data, error } = await builder.maybeSingle();
      if (error) throw error;
      return data as { id: string; title: string; icon: string | null; slug: string; content: string | null } | null;
    }
    try {
      const doc = isUuid ? await this.repo.getById(q) : await this.repo.getBySlug(projectId, q);
      return { id: doc.id, title: doc.title, icon: doc.icon, slug: doc.slug, content: doc.content };
    } catch {
      return null;
    }
  }

  async search(projectId: string, query: string, input?: { limit?: number; cursor?: string | null; tags?: string[] }) {
    if (this.supabase) {
      let builder = this.supabase
        .from('docs')
        .select('id, parent_id, title, slug, icon, sort_order, is_folder, updated_at')
        .eq('project_id', projectId)
        .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
        .order('updated_at', { ascending: false });
      if (input?.tags?.length) builder = (builder as unknown as { contains: (col: string, val: string[]) => typeof builder }).contains('tags', input.tags);
      if (input?.cursor) builder = builder.lt('updated_at', input.cursor);
      if (input?.limit) builder = builder.limit(input.limit + 1);
      const { data, error } = await builder;
      if (error) throw error;
      return data;
    }
    // OSS: title-only search via list (content search not supported in SQLite repo)
    const all = await this.repo.list({ project_id: projectId, limit: input?.limit, cursor: input?.cursor ?? undefined });
    return all.filter((d) => d.title.toLowerCase().includes(query.toLowerCase()));
  }
}
