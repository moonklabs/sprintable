import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  IMemoRepository,
  Memo,
  CreateMemoInput,
  UpdateMemoInput,
  MemoReply,
  MemoListFilters,
  RepositoryScopeContext,
} from '@sprintable/core-storage';
import { ForbiddenError } from '@sprintable/core-storage';
import { mapSupabaseError } from './utils';

export class SupabaseMemoRepository implements IMemoRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateMemoInput): Promise<Memo> {
    const { data, error } = await this.supabase
      .from('memos')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title ?? null,
        content: input.content.trim(),
        memo_type: input.memo_type ?? 'memo',
        assigned_to: input.assigned_to ?? null,
        supersedes_id: input.supersedes_id ?? null,
        created_by: input.created_by,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as Memo;
  }

  async list(filters: MemoListFilters): Promise<Memo[]> {
    let query = this.supabase
      .from('memos')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (filters.org_id && !filters.project_id) query = query.eq('org_id', filters.org_id);
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);
    if (filters.created_by) query = query.eq('created_by', filters.created_by);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.q?.trim()) query = query.or(`title.ilike.%${filters.q.trim()}%,content.ilike.%${filters.q.trim()}%`);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Memo[];
  }

  async getById(id: string, scope?: RepositoryScopeContext): Promise<Memo> {
    let query = this.supabase.from('memos').select('*').eq('id', id).is('deleted_at', null);
    if (scope?.org_id) query = query.eq('org_id', scope.org_id);
    if (scope?.project_id) query = query.eq('project_id', scope.project_id);
    const { data, error } = await query.single();
    if (error) throw mapSupabaseError(error);
    return data as Memo;
  }

  async update(id: string, input: UpdateMemoInput): Promise<Memo> {
    const ALLOWED: (keyof UpdateMemoInput)[] = ['title', 'content', 'status', 'assigned_to', 'metadata'];
    const patch: Record<string, unknown> = {};
    for (const key of ALLOWED) {
      if (key in input) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) throw new Error('No valid fields to update');

    const { data, error } = await this.supabase
      .from('memos')
      .update(patch)
      .eq('id', id)
      .is('deleted_at', null)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Memo;
  }

  async resolve(id: string, resolvedBy: string): Promise<Memo> {
    const { data, error } = await this.supabase
      .from('memos')
      .update({
        status: 'resolved',
        resolved_by: resolvedBy,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();
    if (error) throw mapSupabaseError(error);
    return data as Memo;
  }

  async addReply(input: { memo_id: string; content: string; created_by: string; review_type?: string }): Promise<MemoReply> {
    const { data, error } = await this.supabase
      .from('memo_replies')
      .insert({
        memo_id: input.memo_id,
        content: input.content.trim(),
        created_by: input.created_by,
        review_type: input.review_type ?? 'comment',
      })
      .select()
      .single();
    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data as MemoReply;
  }

  async getReplies(memoId: string): Promise<MemoReply[]> {
    const { data, error } = await this.supabase
      .from('memo_replies')
      .select('*')
      .eq('memo_id', memoId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MemoReply[];
  }
}
