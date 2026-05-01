import type { SupabaseClient } from '@supabase/supabase-js';
import type { IInboxItemRepository, InboxItem, CreateInboxItemInput, InboxListFilters, ResolveInboxItemInput, DismissInboxItemInput, ReassignInboxItemInput, InboxItemCount, InboxKind } from '@sprintable/core-storage';
import { ForbiddenError, NotFoundError } from '@sprintable/core-storage';
import { fastapiCall, mapSupabaseError } from './utils';

export class SupabaseInboxItemRepository implements IInboxItemRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    if (this.fastapi) return fastapiCall<InboxItem>('POST', '/api/v2/inbox', this.accessToken, { body: input });
    const { data: existing } = await this.supabase.from('inbox_items').select('*').eq('org_id', input.org_id).eq('source_type', input.source_type).eq('source_id', input.source_id).eq('kind', input.kind).maybeSingle();
    if (existing) return existing as InboxItem;
    const { data, error } = await this.supabase.from('inbox_items').insert({ org_id: input.org_id, project_id: input.project_id, assignee_member_id: input.assignee_member_id, kind: input.kind, title: input.title, context: input.context ?? null, agent_summary: input.agent_summary ?? null, origin_chain: input.origin_chain ?? [], options: input.options ?? [], after_decision: input.after_decision ?? null, from_agent_id: input.from_agent_id ?? null, story_id: input.story_id ?? null, memo_id: input.memo_id ?? null, priority: input.priority ?? 'normal', source_type: input.source_type, source_id: input.source_id }).select().single();
    if (error) { if (error.code === '42501') throw new ForbiddenError('Permission denied'); throw mapSupabaseError(error); }
    return data as InboxItem;
  }

  async list(filters: InboxListFilters): Promise<InboxItem[]> {
    if (this.fastapi) return fastapiCall<InboxItem[]>('GET', '/api/v2/inbox', this.accessToken, { query: { assignee_member_id: filters.assignee_member_id, kind: filters.kind, state: filters.state } });
    let query = this.supabase.from('inbox_items').select('*').eq('org_id', filters.org_id).order('created_at', { ascending: false });
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.assignee_member_id) query = query.eq('assignee_member_id', filters.assignee_member_id);
    if (filters.kind) query = query.eq('kind', filters.kind);
    if (filters.state) query = query.eq('state', filters.state);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit);
    const { data, error } = await query;
    if (error) throw mapSupabaseError(error);
    return (data ?? []) as InboxItem[];
  }

  async get(id: string, orgId: string): Promise<InboxItem | null> {
    if (this.fastapi) {
      try { return await fastapiCall<InboxItem>('GET', `/api/v2/inbox/${id}`, this.accessToken); }
      catch (e) { if (e instanceof NotFoundError) return null; throw e; }
    }
    const { data, error } = await this.supabase.from('inbox_items').select('*').eq('id', id).eq('org_id', orgId).maybeSingle();
    if (error) throw mapSupabaseError(error);
    return (data as InboxItem | null) ?? null;
  }

  async count(filters: Omit<InboxListFilters, 'limit' | 'cursor'>): Promise<InboxItemCount> {
    let query = this.supabase.from('inbox_items').select('kind', { count: 'exact', head: false }).eq('org_id', filters.org_id);
    if (filters.project_id) query = query.eq('project_id', filters.project_id);
    if (filters.assignee_member_id) query = query.eq('assignee_member_id', filters.assignee_member_id);
    if (filters.state) query = query.eq('state', filters.state);
    const { data, error } = await query;
    if (error) throw mapSupabaseError(error);
    const byKind: Record<InboxKind, number> = { approval: 0, decision: 0, blocker: 0, mention: 0 };
    let total = 0;
    for (const row of data ?? []) { const k = (row as { kind: InboxKind }).kind; byKind[k] = (byKind[k] ?? 0) + 1; total += 1; }
    return { total, byKind };
  }

  async resolve(id: string, orgId: string, input: ResolveInboxItemInput): Promise<InboxItem> {
    if (this.fastapi) return fastapiCall<InboxItem>('POST', `/api/v2/inbox/${id}/resolve`, this.accessToken, { body: input });
    const { data, error } = await this.supabase.rpc('resolve_inbox_item', { p_id: id, p_org_id: orgId, p_resolved_by: input.resolved_by, p_resolved_option_id: input.resolved_option_id, p_resolved_note: input.resolved_note ?? null });
    if (error) { if (error.code === 'P0002') throw new NotFoundError(`Inbox item not found: ${id}`); throw mapSupabaseError(error); }
    return data as InboxItem;
  }

  async dismiss(id: string, orgId: string, input: DismissInboxItemInput): Promise<InboxItem> {
    if (this.fastapi) return fastapiCall<InboxItem>('POST', `/api/v2/inbox/${id}/dismiss`, this.accessToken, { body: input });
    const { data, error } = await this.supabase.rpc('dismiss_inbox_item', { p_id: id, p_org_id: orgId, p_resolved_by: input.resolved_by, p_resolved_note: input.resolved_note ?? null });
    if (error) { if (error.code === 'P0002') throw new NotFoundError(`Inbox item not found: ${id}`); throw mapSupabaseError(error); }
    return data as InboxItem;
  }

  async reassign(id: string, orgId: string, input: ReassignInboxItemInput): Promise<InboxItem> {
    const { data, error } = await this.supabase.rpc('reassign_inbox_item', { p_id: id, p_org_id: orgId, p_new_assignee_member_id: input.new_assignee_member_id, p_reassigned_by: input.reassigned_by });
    if (error) { if (error.code === 'P0002') throw new NotFoundError(`Inbox item not found: ${id}`); throw mapSupabaseError(error); }
    return data as InboxItem;
  }
}
