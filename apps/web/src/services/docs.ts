import type { SupabaseClient } from '@supabase/supabase-js';

export class DocsService {
  constructor(private readonly supabase: SupabaseClient) {}

  async list(projectId: string, input?: { limit?: number; cursor?: string | null }) {
    let query = this.supabase
      .from('docs')
      .select('id, parent_id, title, slug, icon, sort_order, is_folder, updated_at')
      .eq('project_id', projectId)
      .order('updated_at', { ascending: false });
    if (input?.cursor) query = query.lt('updated_at', input.cursor);
    if (input?.limit) query = query.limit(input.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getTree(projectId: string) {
    const { data, error } = await this.supabase
      .from('docs')
      .select('id, parent_id, title, slug, icon, sort_order, is_folder, updated_at')
      .eq('project_id', projectId)
      .order('sort_order');
    if (error) throw error;
    return data;
  }

  async getDoc(projectId: string, slug: string) {
    const { data, error } = await this.supabase
      .from('docs')
      .select('*')
      .eq('project_id', projectId)
      .eq('slug', slug)
      .single();
    if (error) throw error;
    return data;
  }

  async createDoc(input: { org_id: string; project_id: string; title: string; slug: string; content?: string; content_format?: 'markdown' | 'html'; icon?: string | null; tags?: string[]; parent_id?: string; is_folder?: boolean; created_by: string }) {
    const { data, error } = await this.supabase.from('docs').insert(input).select().single();
    if (error) throw error;
    return data;
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
      created_by?: string;
      expected_updated_at?: string;
      force_overwrite?: boolean;
    },
  ) {
    const { expected_updated_at, force_overwrite, ...fields } = input;

    let query = this.supabase.from('docs').update(fields).eq('id', id);

    if (expected_updated_at && !force_overwrite) {
      query = query.eq('updated_at', expected_updated_at);
    }

    const { data, error } = await query.select().maybeSingle();
    if (error) throw error;

    if (!data) {
      if (expected_updated_at && !force_overwrite) {
        const { data: current, error: fetchErr } = await this.supabase
          .from('docs')
          .select('updated_at')
          .eq('id', id)
          .single();
        if (fetchErr) throw fetchErr;

        const err = new Error('Document was modified by another user');
        (err as Error & { code?: string; server_updated_at?: string }).code = 'CONFLICT';
        (err as Error & { code?: string; server_updated_at?: string }).server_updated_at = current.updated_at;
        throw err;
      }

      throw new Error(`Document not found: ${id}`);
    }

    // 리비전은 DB 트리거(trg_docs_auto_revision)가 자동 생성.
    // content 변경 시 50개 초과분만 정리 (SID:365)
    if (fields.content !== undefined) {
      await this.supabase.rpc('trim_doc_revisions', { _doc_id: id, _keep: 50 });
    }

    return data;
  }

  /** Fetch only updated_at for lightweight polling */
  async getDocTimestamp(id: string) {
    const { data, error } = await this.supabase
      .from('docs')
      .select('updated_at')
      .eq('id', id)
      .single();
    if (error) throw error;
    return data;
  }

  async getRevisions(docId: string) {
    const { data, error } = await this.supabase.from('doc_revisions').select('*').eq('doc_id', docId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  }

  async getComments(docId: string) {
    const { data, error } = await this.supabase.from('doc_comments').select('*').eq('doc_id', docId).order('created_at');
    if (error) throw error;
    return data;
  }

  async addComment(input: { doc_id: string; content: string; created_by: string }) {
    const { data, error } = await this.supabase.from('doc_comments').insert(input).select().single();
    if (error) throw error;
    return data;
  }

  async deleteDoc(id: string) {
    // soft delete
    const { error } = await this.supabase.from('docs').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
  }

  /** Fetch preview fields (id, title, icon, slug, content) by UUID or slug */
  async getDocPreview(projectId: string, q: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
    let builder = this.supabase
      .from('docs')
      .select('id, title, icon, slug, content')
      .eq('project_id', projectId);
    builder = isUuid ? builder.eq('id', q) : builder.eq('slug', q);
    const { data, error } = await builder.maybeSingle();
    if (error) throw error;
    return data as { id: string; title: string; icon: string | null; slug: string; content: string | null } | null;
  }

  async search(projectId: string, query: string, input?: { limit?: number; cursor?: string | null }) {
    let builder = this.supabase
      .from('docs')
      .select('id, parent_id, title, slug, icon, sort_order, is_folder, updated_at')
      .eq('project_id', projectId)
      .or(`title.ilike.%${query}%,content.ilike.%${query}%`)
      .order('updated_at', { ascending: false });
    if (input?.cursor) builder = builder.lt('updated_at', input.cursor);
    if (input?.limit) builder = builder.limit(input.limit + 1);
    const { data, error } = await builder;
    if (error) throw error;
    return data;
  }
}
