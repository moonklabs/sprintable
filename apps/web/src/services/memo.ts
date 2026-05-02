
import type { SupabaseClient } from '@/types/supabase';
import type { IMemoRepository, ITeamMemberRepository, IProjectRepository, Memo, MemoReply } from '@sprintable/core-storage';
import { ApiMemoRepository } from '@sprintable/storage-api';
import { dispatchMemoAssignmentImmediately, type DispatchableMemo } from './memo-assignment-dispatch';
import { dispatchWorkflowMemoReplyWebhooks } from './memo-reply-webhook-dispatch';
import { buildAbsoluteMemoLink } from './app-url';
import { NotFoundError, ForbiddenError } from './sprint';
import { NotificationService } from './notification.service';
import { hasExactMemberMention } from './doc-comment-notifications';
import { InboxItemService } from './inbox-item.service';

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
  private readonly repo: IMemoRepository;
  private readonly db: SupabaseClient | null;
  private readonly teamMemberRepo: ITeamMemberRepository | null;
  private readonly projectRepo: IProjectRepository | null;

  constructor(
    repo: IMemoRepository,
    db?: SupabaseClient,
    teamMemberRepo?: ITeamMemberRepository,
    projectRepo?: IProjectRepository,
  ) {
    this.repo = repo;
    this.db = db ?? null;
    this.teamMemberRepo = teamMemberRepo ?? null;
    this.projectRepo = projectRepo ?? null;
  }

  static fromDb(db: SupabaseClient): MemoService {
    return new MemoService(new ApiMemoRepository(), db);
  }

  private async ensureActiveTeamMember(orgId: string, projectId: string, memberId: string, message: string) {
    if (!this.db) return; // OSS: skip — API key auth already validated caller
    const { data: member } = await this.db
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

  private async enrichMemo(memo: Memo) {
    const memoId = memo.id;
    const projectId = memo.project_id;

    const replies = await this.repo.getReplies(memoId);

    const latestReplyAt = replies.length ? replies[replies.length - 1]?.created_at ?? null : null;
    const latestReplyAuthor = replies.length ? replies[replies.length - 1]?.created_by : undefined;

    const timeline = [
      { label: 'created', at: memo.created_at, by: memo.created_by as string | undefined },
      ...(latestReplyAt ? [{ label: 'latest reply', at: latestReplyAt, by: latestReplyAuthor as string | undefined }] : []),
    ];

    if (!this.db) {
      return {
        ...memo,
        reply_count: replies.length,
        latest_reply_at: latestReplyAt,
        project_name: null,
        timeline,
        linked_docs: [],
        readers: [],
        replies,
      };
    }

    const [projectResult, linksResult, readsResult] = await Promise.all([
      this.db
        .from('projects')
        .select('id, name')
        .eq('id', projectId)
        .single(),
      this.db
        .from('memo_doc_links')
        .select('doc_id, created_at')
        .eq('memo_id', memoId)
        .order('created_at', { ascending: true }),
      this.db
        .from('memo_reads')
        .select('memo_id, team_member_id, read_at')
        .eq('memo_id', memoId)
        .order('read_at', { ascending: false }),
    ]);

    if (projectResult.error) throw projectResult.error;
    if (linksResult.error && !this.isMissingOptionalMemoTableError(linksResult.error, 'memo_doc_links')) throw linksResult.error;
    if (readsResult.error && !this.isMissingOptionalMemoTableError(readsResult.error, 'memo_reads')) throw readsResult.error;

    const linkedRows = this.isMissingOptionalMemoTableError(linksResult.error, 'memo_doc_links') ? [] : (linksResult.data ?? []);
    const linkedDocIds: string[] = Array.from(new Set(linkedRows.map((row: LinkedDocRow) => row.doc_id)));
    const linkedDocs = linkedDocIds.length
      ? await this.loadLinkedDocs(linkedDocIds, projectId)
      : [];

    const readRows = this.isMissingOptionalMemoTableError(readsResult.error, 'memo_reads') ? [] : (readsResult.data ?? []);
    const readers = readRows.length
      ? await this.loadReaders(readRows as MemoReadRow[])
      : [];

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
    if (!this.db) return [];
    const { data: docs, error } = await this.db
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
    if (!this.db) return [];
    const readerIds = [...new Set(readRows.map((row) => row.team_member_id))];
    if (!readerIds.length) return [];

    const { data: members, error } = await this.db
      .from('team_members')
      .select('id, name')
      .in('id', readerIds);

    if (error) throw error;

    const memberById = new Map((members ?? []).map((member) => [member.id, member]));
    return readRows
      .map((row) => ({
        id: row.team_member_id,
        name: (memberById.get(row.team_member_id) as { name?: string } | undefined)?.name ?? row.team_member_id,
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
    if (!this.db) return [];
    const rows: Array<{ memo_id: string; created_at: string }> = [];

    for (const chunk of this.chunkValues(memoIds)) {
      const { data, error } = await this.db
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
    if (!this.db) return [];
    const rows: MemoReadRow[] = [];

    for (const chunk of this.chunkValues(memoIds)) {
      const { data, error } = await this.db
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

    if (!this.db) {
      return memos.map((memo) => ({
        ...memo,
        reply_count: 0,
        latest_reply_at: null,
        project_name: null,
        readers: [],
      }));
    }

    const memoIds = memos.map((memo) => memo.id as string).filter(Boolean);
    const projectIds = [...new Set(memos.map((memo) => memo.project_id as string).filter(Boolean))];

    const [replyRows, projectsResult, readRows] = await Promise.all([
      memoIds.length ? this.loadMemoReplyRows(memoIds) : Promise.resolve([]),
      projectIds.length
        ? this.db
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
        project_name: (projectNameById.get(memo.project_id as string) as string | undefined) ?? null,
        readers: readersByMemoId.get(memoId) ?? [],
      };
    });
  }

  async create(input: CreateMemoInput) {
    if (!input.content?.trim()) throw new Error('content is required');
    if (!input.project_id) throw new Error('project_id is required');
    if (!input.org_id) throw new Error('org_id is required');
    if (!input.created_by) throw new Error('created_by is required');

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

    if (this.db) {
      const { data: project } = await this.db
        .from('projects')
        .select('id, org_id')
        .eq('id', input.project_id)
        .eq('org_id', input.org_id)
        .single();
      if (!project) throw new Error('project_id must belong to the same organization');

      const { data: author } = await this.db
        .from('team_members')
        .select('id')
        .eq('id', input.created_by)
        .eq('org_id', input.org_id)
        .eq('project_id', input.project_id)
        .eq('is_active', true)
        .single();
      if (!author) throw new Error('created_by must be an active team member in the same project');

      if (assigneeIds.length > 0) {
        const { data: assignees } = await this.db
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
        const { data: prevMemo } = await this.db
          .from('memos')
          .select('id')
          .eq('id', input.supersedes_id)
          .eq('org_id', input.org_id)
          .eq('project_id', input.project_id)
          .single();
        if (!prevMemo) throw new Error('supersedes_id must reference a memo in the same project');
      }
    } else if (this.projectRepo && this.teamMemberRepo) {
      const project = await this.projectRepo.getById(input.project_id).catch(() => null);
      if (!project || project.org_id !== input.org_id) throw new Error('project_id must belong to the same organization');

      const author = await this.teamMemberRepo.getById(input.created_by).catch(() => null);
      if (!author || author.org_id !== input.org_id || author.project_id !== input.project_id || !author.is_active) {
        throw new Error('created_by must be an active team member in the same project');
      }

      if (assigneeIds.length > 0) {
        const resolvedAssignees = await Promise.all(
          assigneeIds.map((id) => this.teamMemberRepo!.getById(id).catch(() => null)),
        );
        const valid = resolvedAssignees.filter(
          (m) => m && m.org_id === input.org_id && m.project_id === input.project_id,
        );
        if (valid.length !== assigneeIds.length) {
          throw new Error('All assigned_to_ids must be team members in the same project');
        }
      }
    }

    const data = await this.repo.create({
      project_id: input.project_id,
      org_id: input.org_id,
      title: input.title ?? null,
      content: input.content.trim(),
      memo_type: input.memo_type ?? 'memo',
      assigned_to: assigneeIds[0] ?? null,
      supersedes_id: input.supersedes_id ?? null,
      created_by: input.created_by,
      metadata: input.metadata ?? {},
    });

    if (this.db && assigneeIds.length > 0) {
      const assigneeRows = assigneeIds.map((memberId) => ({
        memo_id: data.id,
        member_id: memberId,
        assigned_by: input.created_by,
      }));

      const { error: assigneeError } = await this.db
        .from('memo_assignees')
        .insert(assigneeRows);

      if (assigneeError) {
        console.warn('[MemoService.create] Failed to insert memo_assignees:', assigneeError.message);
        (data as unknown as Record<string, unknown>)._assignee_warning = `memo_assignees insert failed: ${assigneeError.message}`;
      }
    }

    if (input.supersedes_id) {
      if (this.db) {
        await this.db
          .from('memos')
          .update({ status: 'resolved', resolved_by: input.created_by, resolved_at: new Date().toISOString() })
          .eq('id', input.supersedes_id)
          .eq('org_id', input.org_id);
      } else {
        await this.repo.resolve(input.supersedes_id, input.created_by);
      }
    }

    for (const assigneeId of assigneeIds) {
      await dispatchMemoAssignmentImmediately({
        ...data,
        assigned_to: assigneeId,
      } as DispatchableMemo);
    }

    // @멘션 파싱 + DB 저장 + 알림 (fire-and-forget)
    if (this.db) {
      this._processMemoMentions(data.id, input.content.trim(), input.org_id, input.project_id, input.created_by).catch(() => {});
    }

    return data;
  }

  private async _processMemoMentions(memoId: string, content: string, orgId: string, projectId: string, authorId: string): Promise<void> {
    if (!this.db) return;
    const notifService = new NotificationService(this.db);

    const { data: members } = await this.db
      .from('team_members')
      .select('id, name')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('is_active', true);

    const mentionedIds: string[] = [];
    for (const member of (members ?? []) as Array<{ id: string; name: string | null }>) {
      if (!member.name?.trim() || member.id === authorId) continue;
      if (!hasExactMemberMention(content, member.name.trim())) continue;
      mentionedIds.push(member.id);
    }

    if (mentionedIds.length === 0) return;

    // memo_mentions DB 저장 (ON CONFLICT DO NOTHING)
    await this.db
      .from('memo_mentions')
      .upsert(
        mentionedIds.map((uid) => ({ memo_id: memoId, mentioned_user_id: uid })),
        { onConflict: 'memo_id,mentioned_user_id', ignoreDuplicates: true },
      );

    // 멘션 알림 + inbox 듀얼 쓰기
    // notifications → 곧 inbox_items로 일원화 (Phase A.B). 그동안 둘 다 emit.
    const inboxService = new InboxItemService(this.db);

    for (const userId of mentionedIds) {
      await notifService.create({
        org_id: orgId,
        user_id: userId,
        type: 'memo_mention',
        title: '메모에서 멘션되었습니다',
        body: content.slice(0, 100),
        reference_type: 'memo',
        reference_id: memoId,
      });

      // Inbox dual-write — idempotent via UNIQUE (org_id, source_type, source_id, kind).
      // Failure here must not block the legacy notification path.
      try {
        await inboxService.produceMentionFromMemo({
          org_id: orgId,
          project_id: projectId,
          assignee_member_id: userId,
          memo_id: memoId,
          title: '메모에서 멘션됨',
          context: content.slice(0, 500),
          source_id: `${memoId}:${userId}`,
        });
      } catch (err: unknown) {
        console.error('[MemoService._processMemoMentions] inbox dual-write failed', err);
      }
    }
  }

  async list(filters: { org_id?: string; project_id?: string; assigned_to?: string; created_by?: string; status?: string; limit?: number; cursor?: string | null; q?: string; include_archived?: boolean }) {
    const memos = await this.repo.list({
      org_id: filters.org_id,
      project_id: filters.project_id,
      assigned_to: filters.assigned_to,
      created_by: filters.created_by,
      status: filters.status,
      q: filters.q,
      include_archived: filters.include_archived,
      cursor: filters.cursor ?? undefined,
      limit: filters.limit,
    });
    return this.buildListSummaries(memos as MemoListRow[]);
  }

  async getById(id: string) {
    return this.repo.getById(id);
  }

  async getByIdWithDetails(id: string) {
    const memo = await this.repo.getById(id);
    const enriched = await this.enrichMemo(memo);

    const chain: unknown[] = [];
    let currentId: string | null = memo.supersedes_id ?? null;
    let depth = 0;
    while (currentId && depth < 10) {
      try {
        const prev = await this.repo.getById(currentId);
        chain.push({ id: prev.id, title: prev.title, status: prev.status, supersedes_id: prev.supersedes_id, created_at: prev.created_at });
        currentId = (prev.supersedes_id as string | null) ?? null;
      } catch {
        break;
      }
      depth++;
    }

    return { ...enriched, supersedes_chain: chain };
  }

  async addReply(memoId: string, content: string, createdBy: string, reviewType = 'comment', additionalRecipientIds?: string[]) {
    if (!content?.trim()) throw new Error('content is required');

    const memo = await this.repo.getById(memoId);

    let data: MemoReply;
    try {
      data = await this.repo.addReply({
        memo_id: memoId,
        content: content.trim(),
        created_by: createdBy,
        review_type: reviewType,
      });
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err?.code === '42501') throw new ForbiddenError('Permission denied');
      throw error;
    }

    if (data) {
      if (this.db) {
        try {
          await dispatchWorkflowMemoReplyWebhooks({
            db: this.db,
            memo: {
              id: memo.id,
              org_id: memo.org_id,
              project_id: memo.project_id,
              title: memo.title ?? null,
              created_by: memo.created_by,
              assigned_to: memo.assigned_to ?? null,
              metadata: (memo.metadata as Record<string, unknown> | null | undefined) ?? null,
            },
            reply: {
              id: data.id,
              memo_id: data.memo_id,
              content: data.content,
              created_by: data.created_by,
            },
            additionalRecipientIds,
            appUrl: process.env.NEXT_PUBLIC_APP_URL,
          });
        } catch (dispatchError) {
          console.warn('[MemoService.addReply] workflow reply webhook dispatch failed', dispatchError);
        }

        // In-app notifications: memo_reply + memo_mention
        this._sendReplyNotifications(memo, data).catch(() => {});
      } else if (this.teamMemberRepo) {
        try {
          await this.dispatchOssReplyWebhooks(memo, data, additionalRecipientIds);
        } catch (dispatchError) {
          console.warn('[MemoService.addReply] OSS reply webhook dispatch failed', dispatchError);
        }
      }
    }

    return data;
  }

  private async _sendReplyNotifications(memo: Memo, reply: MemoReply) {
    if (!this.db) return;
    const notifService = new NotificationService(this.db);
    const replyAuthor = reply.created_by;

    // memo_reply: 원 메모 작성자에게 (자기 자신 제외)
    if (memo.created_by !== replyAuthor) {
      await notifService.create({
        org_id: memo.org_id,
        user_id: memo.created_by,
        type: 'memo_reply',
        title: '메모에 답장이 달렸습니다',
        body: reply.content.slice(0, 100),
        reference_type: 'memo',
        reference_id: memo.id,
      });
    }

    // memo_mention: @멘션 대상자 (자기 자신 제외)
    const { data: members } = await this.db
      .from('team_members')
      .select('id, name')
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .eq('is_active', true);

    for (const member of (members ?? []) as Array<{ id: string; name: string | null }>) {
      if (!member.name?.trim() || member.id === replyAuthor) continue;
      if (!hasExactMemberMention(reply.content, member.name.trim())) continue;
      await notifService.create({
        org_id: memo.org_id,
        user_id: member.id,
        type: 'memo_mention',
        title: '메모에서 멘션되었습니다',
        body: reply.content.slice(0, 100),
        reference_type: 'memo',
        reference_id: memo.id,
      });
    }
  }

  private async dispatchOssReplyWebhooks(memo: Memo, reply: MemoReply, additionalRecipientIds?: string[]) {
    if (!this.teamMemberRepo) return;

    const members = await this.teamMemberRepo.list({ org_id: memo.org_id, project_id: memo.project_id, is_active: true });
    const priorReplies = await this.repo.getReplies(memo.id);

    const participants = new Set<string>([memo.created_by]);
    if (memo.assigned_to) participants.add(memo.assigned_to);
    for (const r of priorReplies) participants.add(r.created_by);
    for (const id of (additionalRecipientIds ?? [])) participants.add(id);

    // Parse @mentions from current and prior replies — add to notification recipients
    const allContents = [reply.content, ...priorReplies.map((r) => r.content ?? '')];
    for (const member of members) {
      const name = (member as { id: string; name?: string; is_active?: boolean; webhook_url?: string }).name?.trim();
      if (name && allContents.some((c) => c.includes(`@${name}`))) {
        participants.add(member.id);
      }
    }

    participants.delete(reply.created_by);

    const memberById = new Map(members.map((m) => [m.id, m]));
    const authorName = memberById.get(reply.created_by)?.name ?? reply.created_by;
    const memoLabel = memo.title?.trim() ? `"${memo.title.trim()}"` : `#${memo.id}`;
    const memoLink = buildAbsoluteMemoLink(memo.id, process.env.NEXT_PUBLIC_APP_URL);
    const preview = reply.content.replace(/\s+/g, ' ').trim().slice(0, 50);
    const title = `💬 답장: ${authorName}`;
    const description = `메모 ${memoLabel}에 답장\n${preview}\n\n${memoLink}`;

    for (const participantId of participants) {
      const member = memberById.get(participantId);
      if (!member?.is_active || !member.webhook_url) continue;

      try {
        const format = this.detectWebhookFormat(member.webhook_url);
        const body = format === 'discord'
          ? JSON.stringify({ content: `${title}\n${description.substring(0, 500)}`, embeds: [{ title, description, color: 0x3B82F6 }] })
          : JSON.stringify({ text: `*${title}*\n${description}` });

        await fetch(member.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        console.warn('[MemoService.dispatchOssReplyWebhooks] failed for member', participantId, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private detectWebhookFormat(url: string): 'discord' | 'other' {
    if (url.includes('/api/webhooks') && (url.includes('discord.com') || url.includes('discordapp.com'))) {
      return 'discord';
    }
    return 'other';
  }

  async resolve(id: string, resolvedBy: string) {
    const memo = await this.repo.getById(id);
    if (memo.status === 'resolved') throw new Error('Memo is already resolved');
    return this.repo.resolve(id, resolvedBy);
  }

  async linkDoc(memoId: string, docId: string, createdBy: string) {
    if (!this.db) throw new Error('linkDoc requires DB client');
    const memo = await this.repo.getById(memoId);
    await this.ensureActiveTeamMember(memo.org_id, memo.project_id as string, createdBy, 'created_by must be an active team member in the same project');

    const { data: doc } = await this.db
      .from('docs')
      .select('id, project_id, org_id')
      .eq('id', docId)
      .eq('project_id', memo.project_id)
      .eq('org_id', memo.org_id)
      .single();
    if (!doc) throw new Error('doc_id must reference a doc in the same project');

    const { data, error } = await this.db
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
    if (!this.db) return { memo_id: memoId, team_member_id: teamMemberId, read_at: new Date().toISOString() };
    const memo = await this.repo.getById(memoId);
    await this.ensureActiveTeamMember(memo.org_id, memo.project_id as string, teamMemberId, 'team_member_id must be an active team member in the same project');

    const { data, error } = await this.db
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
