import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchMemoAssignmentImmediately, type DispatchableMemo } from './memo-assignment-dispatch';
import { dispatchWorkflowMemoReplyWebhooks } from './memo-reply-webhook-dispatch';
import { NotFoundError, ForbiddenError } from './sprint';

export interface CreateMemoInput {
  project_id: string;
  org_id: string;
  title?: string | null;
  content: string;
  memo_type?: string;
  assigned_to?: string | null; // DEPRECATED: use assigned_to_ids
  assigned_to_ids?: string[]; // New: supports multiple assignees
  supersedes_id?: string | null;
  created_by: string;
  metadata?: Record<string, unknown>;
}

interface LinkedDocRow {
  doc_id: string;
  created_at: string;
}

interface MemoReadRow {
  memo_id: string;
  team_member_id: string;
  read_at: string;
}

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

interface MemoListRow {
  id: string;
  project_id: string;
  title: string | null;
  content: string;
  status: string;
  memo_type: string;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
}

const MEMO_LIST_BATCH_SIZE = 100;

export class MemoService {
  constructor(private readonly supabase: SupabaseClient) {}

  private async ensureActiveTeamMember(orgId: string, projectId: string, memberId: string, message: string) {
    const { data: member } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('id', memberId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('is_active', true)
      .single();

    if (!member) throw new Error(message);
    return member;
  }

  private isMissingOptionalMemoTableError(error: PostgrestLikeError | null | undefined, table: 'memo_doc_links' | 'memo_reads') {
    return error?.code === 'PGRST205' && error.message?.includes(`public.${table}`);
  }

  private async enrichMemo<T extends Record<string, unknown>>(memo: T) {
    const memoId = memo.id as string;
    const projectId = memo.project_id as string;

    const [repliesResult, projectResult, linksResult, readsResult] = await Promise.all([
      this.supabase
        .from('memo_replies')
        .select('id, memo_id, content, created_by, review_type, created_at')
        .eq('memo_id', memoId)
        .order('created_at'),
      this.supabase
        .from('projects')
        .select('id, name')
        .eq('id', projectId)
        .single(),
      this.supabase
        .from('memo_doc_links')
        .select('doc_id, created_at')
        .eq('memo_id', memoId)
        .order('created_at', { ascending: true }),
      this.supabase
        .from('memo_reads')
        .select('memo_id, team_member_id, read_at')
        .eq('memo_id', memoId)
        .order('read_at', { ascending: false }),
    ]);

    if (repliesResult.error) throw repliesResult.error;
    if (projectResult.error) throw projectResult.error;
    if (linksResult.error && !this.isMissingOptionalMemoTableError(linksResult.error, 'memo_doc_links')) throw linksResult.error;
    if (readsResult.error && !this.isMissingOptionalMemoTableError(readsResult.error, 'memo_reads')) throw readsResult.error;

    const replies = repliesResult.data ?? [];
    const latestReplyAt = replies.length ? replies[replies.length - 1]?.created_at ?? null : null;
    const latestReplyAuthor = replies.length ? replies[replies.length - 1]?.created_by : undefined;

    const linkedRows = this.isMissingOptionalMemoTableError(linksResult.error, 'memo_doc_links') ? [] : (linksResult.data ?? []);
    const linkedDocIds = [...new Set(linkedRows.map((row: LinkedDocRow) => row.doc_id))];
    const linkedDocs = linkedDocIds.length
      ? await this.loadLinkedDocs(linkedDocIds, projectId)
      : [];

    const readRows = this.isMissingOptionalMemoTableError(readsResult.error, 'memo_reads') ? [] : (readsResult.data ?? []);
    const readers = readRows.length
      ? await this.loadReaders(readRows as MemoReadRow[])
      : [];

    const timeline = [
      { label: 'created', at: memo.created_at as string, by: memo.created_by as string | undefined },
      ...(latestReplyAt ? [{ label: 'latest reply', at: latestReplyAt, by: latestReplyAuthor as string | undefined }] : []),
    ];

    return {
      ...memo,
      reply_count: replies.length,
      latest_reply_at: latestReplyAt,
      project_name: projectResult.data?.name ?? null,
      timeline,
      linked_docs: linkedDocs,
      readers,
      replies,
    };
  }

  private async loadLinkedDocs(linkedDocIds: string[], projectId: string) {
    const { data: docs, error } = await this.supabase
      .from('docs')
      .select('id, title, slug')
      .eq('project_id', projectId)
      .in('id', linkedDocIds);

    if (error) throw error;

    const docsById = new Map((docs ?? []).map((doc) => [doc.id, doc]));
    return linkedDocIds
      .map((docId) => docsById.get(docId))
      .filter(Boolean)
      .map((doc) => doc as { id: string; title: string; slug?: string });
  }

  private async loadReaders(readRows: MemoReadRow[]) {
    const readerIds = [...new Set(readRows.map((row) => row.team_member_id))];
    if (!readerIds.length) return [];

    const { data: members, error } = await this.supabase
      .from('team_members')
      .select('id, name')
      .in('id', readerIds);

    if (error) throw error;

    const memberById = new Map((members ?? []).map((member) => [member.id, member]));
    return readRows
      .map((row) => ({
        id: row.team_member_id,
        name: memberById.get(row.team_member_id)?.name ?? row.team_member_id,
        read_at: row.read_at,
      }))
      .filter((reader) => Boolean(reader.name));
  }

  private chunkValues<T>(values: T[], size = MEMO_LIST_BATCH_SIZE) {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  private async loadMemoReplyRows(memoIds: string[]) {
    const rows: Array<{ memo_id: string; created_at: string }> = [];

    for (const chunk of this.chunkValues(memoIds)) {
      const { data, error } = await this.supabase
        .from('memo_replies')
        .select('memo_id, created_at')
        .in('memo_id', chunk)
        .order('created_at', { ascending: true });

      if (error) throw error;
      rows.push(...((data ?? []) as Array<{ memo_id: string; created_at: string }>));
    }

    return rows;
  }

  private async loadMemoReadRows(memoIds: string[]) {
    const rows: MemoReadRow[] = [];

    for (const chunk of this.chunkValues(memoIds)) {
      const { data, error } = await this.supabase
        .from('memo_reads')
        .select('memo_id, team_member_id, read_at')
        .in('memo_id', chunk)
        .order('read_at', { ascending: false });

      if (error) {
        if (this.isMissingOptionalMemoTableError(error, 'memo_reads')) return [];
        throw error;
      }
      rows.push(...((data ?? []) as MemoReadRow[]));
    }

    return rows;
  }

  private async buildListSummaries<T extends {
    id: string;
    project_id: string;
    created_at: string;
    created_by: string;
  }>(memos: T[]): Promise<Array<T & {
    reply_count: number;
    latest_reply_at: string | null;
    project_name: string | null;
    readers: Array<{ id: string; name: string; read_at: string }>;
  }>> {
    if (!memos.length) return [];

    const memoIds = memos.map((memo) => memo.id as string).filter(Boolean);
    const projectIds = [...new Set(memos.map((memo) => memo.project_id as string).filter(Boolean))];

    const [replyRows, projectsResult, readRows] = await Promise.all([
      memoIds.length ? this.loadMemoReplyRows(memoIds) : Promise.resolve([]),
      projectIds.length
        ? this.supabase
          .from('projects')
          .select('id, name')
          .in('id', projectIds)
        : Promise.resolve({ data: [], error: null }),
      memoIds.length ? this.loadMemoReadRows(memoIds) : Promise.resolve([]),
    ]);

    if (projectsResult.error) throw projectsResult.error;

    const replyStatsByMemoId = new Map<string, { reply_count: number; latest_reply_at: string | null }>();
    for (const reply of replyRows) {
      const memoId = reply.memo_id as string;
      const existing = replyStatsByMemoId.get(memoId) ?? { reply_count: 0, latest_reply_at: null };
      existing.reply_count += 1;
      existing.latest_reply_at = (reply.created_at as string) ?? existing.latest_reply_at;
      replyStatsByMemoId.set(memoId, existing);
    }

    const projectNameById = new Map((projectsResult.data ?? []).map((project) => [project.id as string, project.name as string | null]));

    const readersByMemoId = new Map<string, Array<{ id: string; name: string; read_at: string }>>();
    for (const readRow of readRows as MemoReadRow[]) {
      const memoReaders = readersByMemoId.get(readRow.memo_id) ?? [];
      memoReaders.push({
        id: readRow.team_member_id,
        name: readRow.team_member_id,
        read_at: readRow.read_at,
      });
      readersByMemoId.set(readRow.memo_id, memoReaders);
    }

    return memos.map((memo) => {
      const memoId = memo.id as string;
      const replyStats = replyStatsByMemoId.get(memoId);
      return {
        ...memo,
        reply_count: replyStats?.reply_count ?? 0,
        latest_reply_at: replyStats?.latest_reply_at ?? null,
        project_name: projectNameById.get(memo.project_id as string) ?? null,
        readers: readersByMemoId.get(memoId) ?? [],
      };
    });
  }

  async create(input: CreateMemoInput) {
    if (!input.content?.trim()) throw new Error('content is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');
    if (!input.created_by) throw new Error('created_by is required');

    const { data: project } = await this.supabase
      .from('projects')
      .select('id, org_id')
      .eq('id', input.project_id)
      .eq('org_id', input.org_id)
      .single();
    if (!project) throw new Error('project_id must belong to the same organization');

    const { data: author } = await this.supabase
      .from('team_members')
      .select('id')
      .eq('id', input.created_by)
      .eq('org_id', input.org_id)
      .eq('project_id', input.project_id)
      .eq('is_active', true)
      .single();
    if (!author) throw new Error('created_by must be an active team member in the same project');

    // Normalize assignees: prefer assigned_to_ids over assigned_to
    const assigneeIds = input.assigned_to_ids?.length
      ? input.assigned_to_ids
      : input.assigned_to
        ? [input.assigned_to]
        : [];

    // [DIAG] Warn if no assignees resolved — helps trace upstream nullification
    if (!assigneeIds.length) {
      console.warn('[MemoService.create] assigneeIds resolved to empty. input dump:', JSON.stringify({
        assigned_to: input.assigned_to,
        assigned_to_ids: input.assigned_to_ids,
      }));
    }

    // Validate all assignees
    if (assigneeIds.length > 0) {
      const { data: assignees } = await this.supabase
        .from('team_members')
        .select('id')
        .eq('org_id', input.org_id)
        .eq('project_id', input.project_id)
        .in('id', assigneeIds);

      if (!assignees || assignees.length !== assigneeIds.length) {
        throw new Error('All assigned_to_ids must be team members in the same project');
      }
    }

    if (input.supersedes_id) {
      const { data: prevMemo } = await this.supabase
        .from('memos')
        .select('id')
        .eq('id', input.supersedes_id)
        .eq('org_id', input.org_id)
        .eq('project_id', input.project_id)
        .single();
      if (!prevMemo) throw new Error('supersedes_id must reference a memo in the same project');
    }

    // Insert memo with assigned_to set to first assignee for backward compatibility
    const { data, error } = await this.supabase
      .from('memos')
      .insert({
        project_id: input.project_id,
        org_id: input.org_id,
        title: input.title ?? null,
        content: input.content.trim(),
        memo_type: input.memo_type ?? 'memo',
        assigned_to: assigneeIds[0] ?? null,
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

    // Insert into memo_assignees join table
    if (assigneeIds.length > 0) {
      const assigneeRows = assigneeIds.map((memberId) => ({
        memo_id: data.id as string,
        member_id: memberId,
        assigned_by: input.created_by,
      }));

      const { error: assigneeError } = await this.supabase
        .from('memo_assignees')
        .insert(assigneeRows);

      if (assigneeError) {
        console.warn('[MemoService.create] Failed to insert memo_assignees:', assigneeError.message);
      }
    }

    if (input.supersedes_id) {
      await this.supabase
        .from('memos')
        .update({ status: 'resolved', resolved_by: input.created_by, resolved_at: new Date().toISOString() })
        .eq('id', input.supersedes_id)
        .eq('org_id', input.org_id);
    }

    // Dispatch webhooks for all assignees
    for (const assigneeId of assigneeIds) {
      await dispatchMemoAssignmentImmediately({
        ...data,
        assigned_to: assigneeId,
      } as DispatchableMemo);
    }

    return data;
  }

  async list(filters: { org_id?: string; project_id?: string; assigned_to?: string; status?: string; limit?: number; cursor?: string | null; q?: string }) {
    let query = this.supabase
      .from('memos')
      .select('id, project_id, title, content, status, memo_type, created_by, assigned_to, created_at')
      .order('created_at', { ascending: false });

    // Workspace-wide: filter by org_id if project_id not specified
    if (filters.org_id && !filters.project_id) {
      query = query.eq('org_id', filters.org_id);
    }

    // Project-specific: filter by project_id
    if (filters.project_id) query = query.eq('project_id', filters.project_id);

    if (filters.assigned_to) query = query.eq('assigned_to', filters.assigned_to);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.q?.trim()) query = query.or(`title.ilike.%${filters.q.trim()}%,content.ilike.%${filters.q.trim()}%`);
    if (filters.cursor) query = query.lt('created_at', filters.cursor);
    if (filters.limit) query = query.limit(filters.limit + 1);

    const { data, error } = await query;
    if (error) throw error;
    return this.buildListSummaries((data ?? []) as MemoListRow[]);
  }

  async getById(id: string) {
    const { data, error } = await this.supabase
      .from('memos')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') throw new NotFoundError('Memo not found');
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async getByIdWithDetails(id: string) {
    const memo = await this.getById(id);
    const enriched = await this.enrichMemo(memo);

    const chain: unknown[] = [];
    let currentId: string | null = memo.supersedes_id as string | null;
    let depth = 0;
    while (currentId && depth < 10) {
      const { data: prev } = await this.supabase
        .from('memos')
        .select('id, title, status, supersedes_id, created_at')
        .eq('id', currentId)
        .single();
      if (!prev) break;
      chain.push(prev);
      currentId = (prev as { supersedes_id?: string | null }).supersedes_id ?? null;
      depth++;
    }

    return { ...enriched, supersedes_chain: chain };
  }

  async addReply(memoId: string, content: string, createdBy: string, reviewType = 'comment') {
    if (!content?.trim()) throw new Error('content is required');

    const memo = await this.getById(memoId);

    const { data, error } = await this.supabase
      .from('memo_replies')
      .insert({
        memo_id: memoId,
        content: content.trim(),
        created_by: createdBy,
        review_type: reviewType,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }

    if (data) {
      try {
        await dispatchWorkflowMemoReplyWebhooks({
          supabase: this.supabase,
          memo: {
            id: memo.id as string,
            org_id: memo.org_id as string,
            project_id: memo.project_id as string,
            title: (memo.title as string | null | undefined) ?? null,
            created_by: memo.created_by as string,
            assigned_to: (memo.assigned_to as string | null | undefined) ?? null,
            metadata: (memo.metadata as Record<string, unknown> | null | undefined) ?? null,
          },
          reply: {
            id: data.id as string,
            memo_id: data.memo_id as string,
            content: data.content as string,
            created_by: data.created_by as string,
          },
          appUrl: process.env.NEXT_PUBLIC_APP_URL,
        });
      } catch (dispatchError) {
        console.warn('[MemoService.addReply] workflow reply webhook dispatch failed', dispatchError);
      }
    }

    return data;
  }

  async resolve(id: string, resolvedBy: string) {
    const memo = await this.getById(id);
    if (memo.status === 'resolved') throw new Error('Memo is already resolved');

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

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async linkDoc(memoId: string, docId: string, createdBy: string) {
    const memo = await this.getById(memoId);
    await this.ensureActiveTeamMember(memo.org_id, memo.project_id, createdBy, 'created_by must be an active team member in the same project');

    const { data: doc } = await this.supabase
      .from('docs')
      .select('id, project_id, org_id')
      .eq('id', docId)
      .eq('project_id', memo.project_id)
      .eq('org_id', memo.org_id)
      .single();
    if (!doc) throw new Error('doc_id must reference a doc in the same project');

    const { data, error } = await this.supabase
      .from('memo_doc_links')
      .upsert({
        memo_id: memoId,
        doc_id: docId,
        created_by: createdBy,
      }, { onConflict: 'memo_id,doc_id' })
      .select()
      .single();

    if (error) {
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }

  async markRead(memoId: string, teamMemberId: string) {
    const memo = await this.getById(memoId);
    await this.ensureActiveTeamMember(memo.org_id, memo.project_id, teamMemberId, 'team_member_id must be an active team member in the same project');

    const { data, error } = await this.supabase
      .from('memo_reads')
      .upsert({
        memo_id: memoId,
        team_member_id: teamMemberId,
        read_at: new Date().toISOString(),
      }, { onConflict: 'memo_id,team_member_id' })
      .select()
      .single();

    if (error) {
      if (this.isMissingOptionalMemoTableError(error, 'memo_reads')) {
        return {
          memo_id: memoId,
          team_member_id: teamMemberId,
          read_at: new Date().toISOString(),
        };
      }
      if (error.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }
    return data;
  }
}
