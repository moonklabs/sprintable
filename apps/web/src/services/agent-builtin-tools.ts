
import { z } from 'zod';
import { MemoService } from './memo';
import { StoryService } from './story';
import { EpicService } from './epic';
import { createEpicRepository } from '@/lib/storage/factory';

import { BUILTIN_AGENT_TOOL_NAMES, type BuiltinAgentToolName } from './agent-builtin-tool-names';
export { BUILTIN_AGENT_TOOL_NAMES, type BuiltinAgentToolName };

type AuditSeverity = 'debug' | 'info' | 'warn' | 'error' | 'security';

type AuditLogger = (eventType: string, severity: AuditSeverity, payload: Record<string, unknown>) => Promise<void>;

export type StatusUpdateGateResult = {
  pass: boolean;
  nextStatus: string;
  mode?: string;
  violations?: Array<{ condition?: string; field?: string; message: string }>;
};

export type StatusUpdateGateFn = (
  storyId: string,
  targetStatus: string,
  orgId: string,
  projectId: string,
  actorId: string,
) => Promise<StatusUpdateGateResult | null>;

interface MemoScope {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface AgentScope {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
}

interface ToolExecutionContext {
  memo: MemoScope;
  agent: AgentScope;
  runId: string;
  sessionId: string;
}

interface StoryRecord {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  story_points: number | null;
  description: string | null;
  epic_id: string | null;
  sprint_id: string | null;
  assignee_id: string | null;
  created_at?: string;
  updated_at?: string;
}

interface EpicRecord {
  id: string;
  org_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  description: string | null;
  created_at?: string;
  updated_at?: string;
}

interface MessagingBridgeChannelRecord {
  id: string;
  org_id: string;
  project_id: string;
  platform: 'slack';
  channel_id: string;
  config: Record<string, string> | null;
  is_active: boolean;
}

interface MessagingBridgeOrgAuthRecord {
  id: string;
  org_id: string;
  platform: 'slack';
  access_token_ref: string;
  expires_at: string | null;
}

const MAX_RESULT_TOKENS = 768;
const MAX_FIELD_CHARS = 480;
const MAX_LIST_ITEMS = 10;

const createMemoSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000),
  memo_type: z.string().trim().min(1).max(64).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

const replyMemoSchema = z.object({
  memo_id: z.string().uuid().optional(),
  content: z.string().trim().min(1).max(20_000),
  review_type: z.string().trim().min(1).max(64).optional(),
});

const updateMemoSchema = z.object({
  memo_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  memo_type: z.string().trim().min(1).max(64).optional(),
  status: z.string().trim().min(1).max(64).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
}).refine((value) => Object.keys(value).some((key) => key !== 'memo_id'), {
  message: 'at least one field must be updated',
});

const listMemosSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_ITEMS).optional(),
  status: z.string().trim().min(1).max(64).optional(),
  memo_type: z.string().trim().min(1).max(64).optional(),
  assigned_to: z.string().uuid().optional(),
});

const createStorySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).nullable().optional(),
  epic_id: z.string().uuid().nullable().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done']).optional(),
  story_points: z.coerce.number().int().min(0).max(100).nullable().optional(),
});

const updateStoryStatusSchema = z.object({
  story_id: z.string().uuid(),
  status: z.enum(['backlog', 'ready-for-dev', 'in-progress', 'in-review', 'done']),
});

const createEpicSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).nullable().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  status: z.enum(['open', 'in-progress', 'done']).optional(),
});

const listEpicsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_ITEMS).optional(),
  status: z.string().trim().min(1).max(64).optional(),
});

const listStoriesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_ITEMS).optional(),
  status: z.string().trim().min(1).max(64).optional(),
  epic_id: z.string().uuid().optional(),
  assignee_id: z.string().uuid().optional(),
  sprint_id: z.string().uuid().optional(),
});

const assignStorySchema = z.object({
  story_id: z.string().uuid(),
  assignee_id: z.string().uuid(),
});

const notifySlackSchema = z.object({
  channel_id: z.string().trim().min(1).max(255),
  message: z.string().trim().min(1).max(40_000),
  blocks: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
  thread_ts: z.string().trim().min(1).max(64).optional(),
});

const legacySourceMemoSchema = z.object({
  memo_id: z.string().uuid().optional(),
});

const legacyRecentMemosSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_ITEMS).optional(),
});

const legacyAddReplySchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

const forwardMemoSchema = z.object({
  target_agent_display_name: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  memo_type: z.string().trim().min(1).max(64).optional(),
});

const MAX_FORWARD_CHAIN_DEPTH = 10;

const legacyResolveMemoSchema = z.object({});

function truncateText(text: string, maxChars = MAX_FIELD_CHARS): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function sanitizeTextFields(value: unknown): unknown {
  if (typeof value === 'string') return truncateText(value);
  if (Array.isArray(value)) return value.slice(0, MAX_LIST_ITEMS).map((entry) => sanitizeTextFields(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeTextFields(entry)]));
}

function truncatePayload(value: unknown): unknown {
  const sanitized = sanitizeTextFields(value);
  const json = JSON.stringify(sanitized);
  if (estimateTokens(json) <= MAX_RESULT_TOKENS) return sanitized;
  return {
    truncated: true,
    preview: truncateText(json, MAX_RESULT_TOKENS * 4),
  };
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveSlackSecretRef(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) return env[ref.slice(4)] ?? null;
  if (ref.startsWith('vault:')) return null;
  return ref;
}

function isExpiredTimestamp(value: string | null | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) || timestamp <= now;
}

export class AgentBuiltinToolService {
  private readonly memoService: MemoService;
  private readonly storyService: StoryService;
  private _epicService: EpicService | null;
  private _epicServicePromise: Promise<EpicService> | null = null;
  private readonly auditLogger?: AuditLogger;
  private readonly fetchFn: typeof fetch;
  private readonly statusUpdateGateFn?: StatusUpdateGateFn;

  constructor(
    private readonly db: any,
    options: {
      memoService?: MemoService;
      storyService?: StoryService;
      epicService?: EpicService;
      auditLogger?: AuditLogger;
      fetchFn?: typeof fetch;
      statusUpdateGateFn?: StatusUpdateGateFn;
    } = {},
  ) {
    this.memoService = options.memoService ?? MemoService.fromDb(db);
    this.storyService = options.storyService ?? StoryService.fromDb(db);
    this._epicService = options.epicService ?? null;
    this.auditLogger = options.auditLogger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.statusUpdateGateFn = options.statusUpdateGateFn;
  }

  private async getEpicService(): Promise<EpicService> {
    if (this._epicService) return this._epicService;
    if (!this._epicServicePromise) {
      this._epicServicePromise = createEpicRepository().then((repo) => new EpicService(repo));
    }
    this._epicService = await this._epicServicePromise;
    return this._epicService;
  }

  async execute(toolName: BuiltinAgentToolName, rawArgs: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    try {
      const result = await this.dispatch(toolName, rawArgs, ctx);
      const truncated = truncatePayload(result) as Record<string, unknown>;
      await this.auditLogger?.('agent_tool.executed', 'info', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: toolName,
        tool_source: 'builtin',
        outcome: 'allowed',
        arguments: truncatePayload(rawArgs),
        result: truncated,
      });
      return truncated;
    } catch (error) {
      const message = normalizeError(error);
      await this.auditLogger?.('agent_tool.failed', 'warn', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: toolName,
        tool_source: 'builtin',
        outcome: 'failed',
        arguments: truncatePayload(rawArgs),
        error: message,
      });
      return { error: message };
    }
  }

  private async dispatch(toolName: BuiltinAgentToolName, rawArgs: Record<string, unknown>, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'get_source_memo': {
        const args = legacySourceMemoSchema.parse(rawArgs);
        const memoId = args.memo_id ?? ctx.memo.id;
        const memo = await this.getMemoInScope(memoId, ctx);
        const replies = await this.listMemoReplies(memo.id);
        return { memo: this.presentMemo(memo), replies: replies.map((reply) => this.presentReply(reply)) };
      }
      case 'list_recent_project_memos': {
        const args = legacyRecentMemosSchema.parse(rawArgs);
        return this.listMemosInternal({ limit: args.limit }, ctx);
      }
      case 'add_memo_reply': {
        const args = legacyAddReplySchema.parse(rawArgs);
        return this.replyMemoInternal({ memo_id: ctx.memo.id, content: args.content }, ctx);
      }
      case 'resolve_memo': {
        legacyResolveMemoSchema.parse(rawArgs);
        const resolved = await this.memoService.resolve(ctx.memo.id, ctx.agent.id);
        return { memo_id: resolved.id, status: resolved.status };
      }
      case 'create_memo': {
        const args = createMemoSchema.parse(rawArgs);
        if (args.assigned_to) await this.ensureMemberInScope(args.assigned_to, ctx);
        const memo = await this.memoService.create({
          project_id: ctx.memo.project_id,
          org_id: ctx.memo.org_id,
          title: args.title ?? null,
          content: args.content,
          memo_type: args.memo_type,
          assigned_to: args.assigned_to ?? null,
          created_by: ctx.agent.id,
        });
        return { memo: this.presentMemo(memo as MemoScope) };
      }
      case 'reply_memo': {
        const args = replyMemoSchema.parse(rawArgs);
        return this.replyMemoInternal(args, ctx);
      }
      case 'update_memo': {
        const args = updateMemoSchema.parse(rawArgs);
        const memo = await this.getMemoInScope(args.memo_id ?? ctx.memo.id, ctx);
        if (args.assigned_to) await this.ensureMemberInScope(args.assigned_to, ctx);

        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title.trim();
        if (args.content !== undefined) patch.content = args.content.trim();
        if (args.memo_type !== undefined) patch.memo_type = args.memo_type.trim();
        if (args.status !== undefined) patch.status = args.status.trim();
        if (args.assigned_to !== undefined) patch.assigned_to = args.assigned_to;

        const { data, error } = await this.db
          .from('memos')
          .update(patch)
          .eq('id', memo.id)
          .eq('org_id', ctx.memo.org_id)
          .eq('project_id', ctx.memo.project_id)
          .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, created_at, updated_at')
          .single();

        // memo_assignees upsert — trg_memo_assignees_notify 발동하여 알림 보장
        if (!error && data && args.assigned_to) {
          await this.db
            .from('memo_assignees')
            .upsert(
              { memo_id: memo.id, member_id: args.assigned_to, assigned_by: ctx.memo.created_by },
              { onConflict: 'memo_id,member_id', ignoreDuplicates: true },
            );
        }

        if (error || !data) throw error ?? new Error('memo update failed');
        return { memo: this.presentMemo(data as MemoScope) };
      }
      case 'list_memos': {
        const args = listMemosSchema.parse(rawArgs);
        if (args.assigned_to) await this.ensureMemberInScope(args.assigned_to, ctx);
        return this.listMemosInternal(args, ctx);
      }
      case 'create_story': {
        const args = createStorySchema.parse(rawArgs);
        if (args.assignee_id) await this.ensureMemberInScope(args.assignee_id, ctx);
        if (args.epic_id) await this.ensureEpicInScope(args.epic_id, ctx);
        if (args.sprint_id) await this.ensureSprintInScope(args.sprint_id, ctx);
        const story = await this.storyService.create({
          project_id: ctx.memo.project_id,
          org_id: ctx.memo.org_id,
          title: args.title,
          description: args.description ?? null,
          epic_id: args.epic_id ?? null,
          sprint_id: args.sprint_id ?? null,
          assignee_id: args.assignee_id ?? null,
          priority: args.priority,
          status: args.status,
          story_points: args.story_points ?? null,
        });
        return { story: this.presentStory(story as StoryRecord) };
      }
      case 'update_story_status': {
        const args = updateStoryStatusSchema.parse(rawArgs);
        const story = await this.ensureStoryInScope(args.story_id, ctx);

        if (this.statusUpdateGateFn) {
          const gateResult = await this.statusUpdateGateFn(
            story.id, args.status, ctx.memo.org_id, ctx.memo.project_id, ctx.agent.id
          );
          if (gateResult && !gateResult.pass) {
            return {
              gate_failed: true,
              mode: gateResult.mode,
              violations: gateResult.violations,
              hint: gateResult.violations?.map((v) => v.message).join('; ') ?? 'Gate check failed',
            };
          }
          const nextStatus = gateResult?.nextStatus ?? args.status;
          const updated = await this.storyService.update(story.id, { status: nextStatus });
          return { story: this.presentStory(updated as StoryRecord), gate: gateResult };
        }

        const updated = await this.storyService.update(story.id, { status: args.status });
        return { story: this.presentStory(updated as StoryRecord) };
      }
      case 'create_epic': {
        const args = createEpicSchema.parse(rawArgs);
        const epic = await (await this.getEpicService()).create({
          project_id: ctx.memo.project_id,
          org_id: ctx.memo.org_id,
          title: args.title,
          description: args.description ?? null,
          priority: args.priority,
          status: args.status,
        });
        return { epic: this.presentEpic(epic as EpicRecord) };
      }
      case 'list_epics': {
        const args = listEpicsSchema.parse(rawArgs);
        let epics = await (await this.getEpicService()).list({ project_id: ctx.memo.project_id });
        if (args.status) epics = epics.filter((epic) => epic.status === args.status);
        return { epics: epics.slice(0, args.limit ?? MAX_LIST_ITEMS).map((epic) => this.presentEpic(epic as EpicRecord)) };
      }
      case 'list_stories': {
        const args = listStoriesSchema.parse(rawArgs);
        if (args.assignee_id) await this.ensureMemberInScope(args.assignee_id, ctx);
        if (args.epic_id) await this.ensureEpicInScope(args.epic_id, ctx);
        if (args.sprint_id) await this.ensureSprintInScope(args.sprint_id, ctx);
        const stories = await this.storyService.list({
          project_id: ctx.memo.project_id,
          status: args.status,
          assignee_id: args.assignee_id,
          epic_id: args.epic_id,
          sprint_id: args.sprint_id,
        });
        return { stories: stories.slice(0, args.limit ?? MAX_LIST_ITEMS).map((story) => this.presentStory(story as StoryRecord)) };
      }
      case 'assign_story': {
        const args = assignStorySchema.parse(rawArgs);
        const story = await this.ensureStoryInScope(args.story_id, ctx);
        await this.ensureMemberInScope(args.assignee_id, ctx);
        const updated = await this.storyService.update(story.id, { assignee_id: args.assignee_id });
        return { story: this.presentStory(updated as StoryRecord) };
      }
      case 'notify_slack': {
        const args = notifySlackSchema.parse(rawArgs);
        return this.notifySlackInternal(args, ctx);
      }
      case 'forward_memo': {
        const args = forwardMemoSchema.parse(rawArgs);
        return this.forwardMemoInternal(args, ctx);
      }
      default:
        throw new Error(`Unsupported tool: ${toolName}`);
    }
  }

  private async listMemosInternal(args: { limit?: number; status?: string; memo_type?: string; assigned_to?: string }, ctx: ToolExecutionContext) {
    let query = this.db
      .from('memos')
      .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, created_at, updated_at')
      .eq('org_id', ctx.memo.org_id)
      .eq('project_id', ctx.memo.project_id);

    if (args.status) query = query.eq('status', args.status);
    if (args.memo_type) query = query.eq('memo_type', args.memo_type);
    if (args.assigned_to) query = query.eq('assigned_to', args.assigned_to);

    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(args.limit ?? MAX_LIST_ITEMS);

    if (error) throw error;

    const memos = (data ?? []) as MemoScope[];
    return { memos: memos.map((memo) => this.presentMemo(memo)) };
  }

  private async replyMemoInternal(args: { memo_id?: string; content: string; review_type?: string }, ctx: ToolExecutionContext) {
    const memo = await this.getMemoInScope(args.memo_id ?? ctx.memo.id, ctx);
    const data = await this.memoService.addReply(memo.id, args.content, ctx.agent.id, args.review_type ?? 'comment');
    return { reply: this.presentReply(data as { id: string; memo_id: string; content: string; created_by: string; created_at: string }) };
  }

  private async getMemoInScope(memoId: string, ctx: ToolExecutionContext): Promise<MemoScope> {
    const { data, error } = await this.db
      .from('memos')
      .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, created_at, updated_at')
      .eq('id', memoId)
      .maybeSingle();

    if (error || !data) throw new Error('memo not found');
    if (data.org_id !== ctx.memo.org_id || data.project_id !== ctx.memo.project_id) {
      await this.auditLogger?.('agent_tool.cross_scope_blocked', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'memo_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        user_reason: 'This action was blocked because the referenced memo is outside the current project.',
        operator_reason: 'The builtin tool referenced a memo whose org/project scope does not match the active memo context.',
        next_action: 'Retry with a memo id from the current project scope.',
        memo_id: memoId,
      });
      throw new Error('memo_id outside current project scope');
    }
    return data as MemoScope;
  }

  private async listMemoReplies(memoId: string) {
    const { data, error } = await this.db
      .from('memo_replies')
      .select('id, memo_id, content, created_by, created_at')
      .eq('memo_id', memoId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  private async ensureMemberInScope(memberId: string, ctx: ToolExecutionContext) {
    const { data, error } = await this.db
      .from('team_members')
      .select('id, org_id, project_id')
      .eq('id', memberId)
      .maybeSingle();
    if (error || !data) throw new Error('team member not found');
    if (data.org_id !== ctx.memo.org_id || data.project_id !== ctx.memo.project_id) {
      await this.auditLogger?.('agent_tool.cross_scope_blocked', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'team_member_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        user_reason: 'This action was blocked because the referenced team member is outside the current project.',
        operator_reason: 'The builtin tool referenced a team member whose org/project scope does not match the active memo context.',
        next_action: 'Retry with a team member from the current project scope.',
        member_id: memberId,
      });
      throw new Error('team member outside current project scope');
    }
  }

  private async ensureStoryInScope(storyId: string, ctx: ToolExecutionContext): Promise<StoryRecord> {
    const { data, error } = await this.db
      .from('stories')
      .select('*')
      .eq('id', storyId)
      .maybeSingle();
    if (error || !data) throw new Error('story not found');
    if (data.org_id !== ctx.memo.org_id || data.project_id !== ctx.memo.project_id) {
      await this.auditLogger?.('agent_tool.cross_scope_blocked', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'story_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        user_reason: 'This action was blocked because the referenced story is outside the current project.',
        operator_reason: 'The builtin tool referenced a story whose org/project scope does not match the active memo context.',
        next_action: 'Retry with a story id from the current project scope.',
        story_id: storyId,
      });
      throw new Error('story_id outside current project scope');
    }
    return data as StoryRecord;
  }

  private async ensureEpicInScope(epicId: string, ctx: ToolExecutionContext): Promise<EpicRecord> {
    const { data, error } = await this.db
      .from('epics')
      .select('*')
      .eq('id', epicId)
      .maybeSingle();
    if (error || !data) throw new Error('epic not found');
    if (data.org_id !== ctx.memo.org_id || data.project_id !== ctx.memo.project_id) {
      await this.auditLogger?.('agent_tool.cross_scope_blocked', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'epic_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        user_reason: 'This action was blocked because the referenced epic is outside the current project.',
        operator_reason: 'The builtin tool referenced an epic whose org/project scope does not match the active memo context.',
        next_action: 'Retry with an epic id from the current project scope.',
        epic_id: epicId,
      });
      throw new Error('epic_id outside current project scope');
    }
    return data as EpicRecord;
  }

  private async ensureSprintInScope(sprintId: string, ctx: ToolExecutionContext) {
    const { data, error } = await this.db
      .from('sprints')
      .select('id, org_id, project_id')
      .eq('id', sprintId)
      .maybeSingle();
    if (error || !data) throw new Error('sprint not found');
    if (data.org_id !== ctx.memo.org_id || data.project_id !== ctx.memo.project_id) {
      await this.auditLogger?.('agent_tool.cross_scope_blocked', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'sprint_scope_check',
        tool_source: 'builtin',
        outcome: 'denied',
        user_reason: 'This action was blocked because the referenced sprint is outside the current project.',
        operator_reason: 'The builtin tool referenced a sprint whose org/project scope does not match the active memo context.',
        next_action: 'Retry with a sprint id from the current project scope.',
        sprint_id: sprintId,
      });
      throw new Error('sprint_id outside current project scope');
    }
  }

  private async forwardMemoInternal(args: z.infer<typeof forwardMemoSchema>, ctx: ToolExecutionContext): Promise<Record<string, unknown>> {
    // Resolve target agent by display name within org/project
    const { data: agents, error: agentError } = await this.db
      .from('team_members')
      .select('id, name')
      .eq('org_id', ctx.memo.org_id)
      .eq('project_id', ctx.memo.project_id)
      .eq('type', 'agent')
      .eq('is_active', true)
      .eq('name', args.target_agent_display_name);

    if (agentError) throw agentError;

    const matches = (agents ?? []) as Array<{ id: string; name: string }>;
    if (matches.length === 0) {
      return { error: 'target_agent_not_found' };
    }

    // Filter out self from candidates
    const candidates = matches.filter((a) => a.id !== ctx.agent.id);

    if (candidates.length === 0) {
      // All matches resolved to self
      return { error: 'self_forward_not_allowed' };
    }

    if (candidates.length > 1) {
      // Ambiguous: multiple distinct agents share the same display name
      return { error: 'target_agent_not_found' };
    }

    const targetAgent = candidates[0];

    // Walk the forward chain backward to count hops
    let chainLength = 0;
    let currentId: string | null = ctx.memo.id;
    while (currentId && chainLength < MAX_FORWARD_CHAIN_DEPTH + 1) {
      const { data: chainMemo } = await this.db
        .from('memos')
        .select('id, metadata')
        .eq('id', currentId)
        .maybeSingle() as { data: { id: string; metadata: Record<string, unknown> | null } | null };
      if (!chainMemo) break;
      const fwdFrom = chainMemo.metadata?.forwarded_from_memo_id;
      if (typeof fwdFrom !== 'string') break;
      chainLength++;
      currentId = fwdFrom;
    }

    if (chainLength >= MAX_FORWARD_CHAIN_DEPTH) {
      await this.auditLogger?.('forward_chain_exceeded', 'warn', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: 'forward_memo',
        memo_id: ctx.memo.id,
        chain_length: chainLength,
      });
      return { error: 'forward_chain_limit_exceeded' };
    }

    const memo = await this.memoService.create({
      project_id: ctx.memo.project_id,
      org_id: ctx.memo.org_id,
      title: ctx.memo.title,
      content: args.content,
      memo_type: args.memo_type ?? ctx.memo.memo_type,
      assigned_to: targetAgent.id,
      created_by: ctx.agent.id,
      metadata: { forwarded_from_memo_id: ctx.memo.id },
    });

    return { memo: this.presentMemo(memo as MemoScope) };
  }

  private async notifySlackInternal(args: z.infer<typeof notifySlackSchema>, ctx: ToolExecutionContext) {
    await this.auditLogger?.('mcp_tool.call', 'info', {
      org_id: ctx.memo.org_id,
      project_id: ctx.memo.project_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId,
      session_id: ctx.sessionId,
      tool_name: 'notify_slack',
      action_type: 'mcp_tool.call',
      resource_type: 'slack_channel',
      resource_id: args.channel_id,
      channel_id: args.channel_id,
    });

    const channel = await this.getSlackChannelRegistration(args.channel_id, ctx);
    if (!channel) {
      return { error: 'channel_not_registered' };
    }

    const auth = await this.getActiveSlackOrgAuth(ctx);
    if (!auth) {
      return { error: 'slack_auth_required' };
    }

    const token = resolveSlackSecretRef(auth.access_token_ref);
    if (!token || isExpiredTimestamp(auth.expires_at)) {
      return { error: 'slack_auth_required' };
    }

    const response = await this.fetchFn('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: args.channel_id,
        text: args.message,
        blocks: args.blocks,
        thread_ts: args.thread_ts,
      }),
    });

    let body: { ok?: boolean; error?: string; channel?: string; ts?: string } = {};
    try {
      body = await response.json() as { ok?: boolean; error?: string; channel?: string; ts?: string };
    } catch {
      body = {};
    }

    if (!response.ok || body.ok !== true) {
      return { error: body.error ?? `http_${response.status}` };
    }

    return {
      ok: true,
      channel_id: body.channel ?? args.channel_id,
      message_ts: body.ts ?? null,
      thread_ts: args.thread_ts ?? null,
    };
  }

  private async getSlackChannelRegistration(channelId: string, ctx: ToolExecutionContext): Promise<MessagingBridgeChannelRecord | null> {
    const { data, error } = await this.db
      .from('messaging_bridge_channels')
      .select('id, org_id, project_id, platform, channel_id, config, is_active')
      .eq('org_id', ctx.memo.org_id)
      .eq('project_id', ctx.memo.project_id)
      .eq('platform', 'slack')
      .eq('channel_id', channelId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) throw error;
    return (data as MessagingBridgeChannelRecord | null) ?? null;
  }

  private async getActiveSlackOrgAuth(ctx: ToolExecutionContext): Promise<MessagingBridgeOrgAuthRecord | null> {
    const { data, error } = await this.db
      .from('messaging_bridge_org_auths')
      .select('id, org_id, platform, access_token_ref, expires_at')
      .eq('org_id', ctx.memo.org_id)
      .eq('platform', 'slack')
      .maybeSingle();

    if (error) throw error;
    return (data as MessagingBridgeOrgAuthRecord | null) ?? null;
  }

  private presentMemo(memo: MemoScope) {
    return {
      id: memo.id,
      title: memo.title,
      content: truncateText(memo.content),
      memo_type: memo.memo_type,
      status: memo.status,
      assigned_to: memo.assigned_to,
      created_by: memo.created_by,
      updated_at: memo.updated_at,
    };
  }

  private presentReply(reply: Record<string, unknown>) {
    return {
      id: reply.id,
      memo_id: reply.memo_id,
      content: truncateText(String(reply.content ?? '')),
      created_by: reply.created_by,
      created_at: reply.created_at,
    };
  }

  private presentStory(story: StoryRecord) {
    return {
      id: story.id,
      title: story.title,
      status: story.status,
      priority: story.priority,
      story_points: story.story_points,
      description: story.description ? truncateText(story.description) : null,
      epic_id: story.epic_id,
      sprint_id: story.sprint_id,
      assignee_id: story.assignee_id,
      updated_at: story.updated_at ?? story.created_at ?? null,
    };
  }

  private presentEpic(epic: EpicRecord) {
    return {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      priority: epic.priority,
      description: epic.description ? truncateText(epic.description) : null,
      updated_at: epic.updated_at ?? epic.created_at ?? null,
    };
  }
}
