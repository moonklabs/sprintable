
import { AgentRetryService, type RetryScheduler } from './agent-retry';
import {
  createSessionMemoryWrite,
  partitionSessionMemoryRowsByScope,
  type AgentSessionMemoryScope,
} from '@/lib/agent-memory-contract';

export type AgentSessionStatus = 'active' | 'idle' | 'suspended' | 'terminated';

type AgentRunStatus = 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';

interface SessionMemoryRow {
  id?: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  session_id: string;
  run_id: string | null;
  memory_type: 'context' | 'summary' | 'decision' | 'todo' | 'fact';
  importance?: number | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
}

export interface AgentSessionRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  deployment_id: string | null;
  session_key: string;
  channel: string;
  title: string | null;
  status: AgentSessionStatus;
  context_window_tokens: number | null;
  metadata: Record<string, unknown> | null;
  context_snapshot: Record<string, unknown> | null;
  created_by: string | null;
  started_at: string;
  last_activity_at: string;
  idle_at: string | null;
  suspended_at: string | null;
  ended_at: string | null;
  terminated_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgentSessionRunRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  memo_id: string | null;
  session_id: string | null;
  status: AgentRunStatus;
  retry_count: number;
  max_retries: number;
  started_at: string | null;
  finished_at?: string | null;
  result_summary?: string | null;
  last_error_code?: string | null;
  error_message?: string | null;
}

export interface SessionResumeCandidate {
  runId: string;
  memoId: string;
  orgId: string;
  projectId: string;
  agentId: string;
}

export interface SessionClaimResult {
  session: AgentSessionRecord;
  holdRun: boolean;
  holdReason: 'session_waiting_for_capacity' | 'session_suspended' | null;
  restoredMemoryCount: number;
}

export interface RecoverStaleSessionsResult {
  recoveredCount: number;
  retryScheduledCount: number;
  terminatedCount: number;
  resumedCount: number;
  resumeCandidates: SessionResumeCandidate[];
}

interface AgentSessionLifecycleOptions {
  sessionLimit?: number;
  crashTimeoutMs?: number;
  nowFn?: () => Date;
  retryService?: RetryScheduler;
}

interface SessionSnapshotMemory {
  memory_type: SessionMemoryRow['memory_type'];
  content: string;
  importance: number;
  created_at: string;
}

const DEFAULT_SESSION_LIMIT = 1;
const DEFAULT_CRASH_TIMEOUT_MS = 10 * 60 * 1000;
const SNAPSHOT_MEMORY_LIMIT = 8;

type SessionTransitionReason =
  | 'run_completed'
  | 'run_failed_retry_pending'
  | 'run_final_failure'
  | 'hitl_pending'
  | 'manual_transition'
  | 'session_capacity_released'
  | 'crash_recovery';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function toIsoString(date: Date) {
  return date.toISOString();
}

export class AgentSessionLifecycleError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSessionLifecycleError';
  }
}

export class AgentSessionLifecycleService {
  private readonly sessionLimit: number;
  private readonly crashTimeoutMs: number;
  private readonly nowFn: () => Date;
  private readonly retryService: RetryScheduler;

  constructor(
    private readonly db: any,
    options: AgentSessionLifecycleOptions = {},
  ) {
    this.sessionLimit = Math.max(1, options.sessionLimit ?? Number(process.env['AGENT_SESSION_CONCURRENCY_LIMIT'] ?? DEFAULT_SESSION_LIMIT));
    this.crashTimeoutMs = Math.max(60_000, options.crashTimeoutMs ?? Number(process.env['AGENT_SESSION_CRASH_TIMEOUT_MS'] ?? DEFAULT_CRASH_TIMEOUT_MS));
    this.nowFn = options.nowFn ?? (() => new Date());
    this.retryService = options.retryService ?? new AgentRetryService(db);
  }

  async claimSession(input: {
    run: AgentSessionRunRecord;
    memo: { id: string; memo_type: string; title: string | null; created_by: string | null };
    personaId: string | null;
    deploymentId: string | null;
    channel?: string;
    resumeSuspended?: boolean;
  }): Promise<SessionClaimResult> {
    const sessionKey = `memo:${input.memo.id}`;
    const now = toIsoString(this.nowFn());
    const existing = input.run.session_id
      ? await this.getSessionById(input.run.session_id)
      : await this.getSessionByKey(input.run.org_id, input.run.project_id, input.run.agent_id, sessionKey);

    const activeCount = await this.countActiveSessions(input.run.org_id, input.run.project_id, input.run.agent_id, existing?.id ?? null);
    const hasCapacity = activeCount < this.sessionLimit;

    let targetStatus: AgentSessionStatus = hasCapacity ? 'active' : 'idle';
    let holdReason: SessionClaimResult['holdReason'] = null;

    if (existing?.status === 'active') {
      targetStatus = 'active';
    } else if (existing?.status === 'suspended' && !input.resumeSuspended) {
      targetStatus = 'suspended';
      holdReason = 'session_suspended';
    } else if (!hasCapacity) {
      targetStatus = 'idle';
      holdReason = 'session_waiting_for_capacity';
    }

    const patch: Record<string, unknown> = {
      persona_id: input.personaId,
      deployment_id: input.deploymentId,
      title: input.memo.title ?? `Memo ${input.memo.id}`,
      channel: input.channel ?? 'memo',
      status: targetStatus,
      last_activity_at: now,
      created_by: input.memo.created_by,
      metadata: {
        ...asRecord(existing?.metadata),
        memo_id: input.memo.id,
        memo_type: input.memo.memo_type,
        queue_reason: holdReason,
      },
    };

    if (targetStatus === 'active') {
      patch.idle_at = null;
      patch.suspended_at = null;
      patch.ended_at = null;
      patch.terminated_at = null;
    }
    if (targetStatus === 'idle') {
      patch.idle_at = now;
      patch.suspended_at = null;
      patch.ended_at = null;
      patch.terminated_at = null;
    }
    if (targetStatus === 'suspended') {
      patch.suspended_at = now;
      patch.idle_at = null;
      patch.ended_at = null;
      patch.terminated_at = null;
    }

    const session = existing
      ? await this.updateSession(existing.id, patch)
      : await this.createSession({
        org_id: input.run.org_id,
        project_id: input.run.project_id,
        agent_id: input.run.agent_id,
        persona_id: input.personaId,
        deployment_id: input.deploymentId,
        session_key: sessionKey,
        channel: input.channel ?? 'memo',
        title: input.memo.title ?? `Memo ${input.memo.id}`,
        status: targetStatus,
        metadata: {
          memo_id: input.memo.id,
          memo_type: input.memo.memo_type,
          queue_reason: holdReason,
        },
        created_by: input.memo.created_by,
        started_at: now,
        last_activity_at: now,
        idle_at: targetStatus === 'idle' ? now : null,
        suspended_at: targetStatus === 'suspended' ? now : null,
        terminated_at: null,
        ended_at: null,
      });

    const restoredMemoryCount = targetStatus === 'active'
      ? await this.restoreContextSnapshotIfNeeded(session)
      : 0;

    return {
      session,
      holdRun: targetStatus !== 'active',
      holdReason,
      restoredMemoryCount,
    };
  }

  async applyRunOutcome(input: {
    run: AgentSessionRunRecord;
    sessionId: string;
    outcome: 'completed' | 'hitl_pending' | 'failed';
    errorCode?: string | null;
    errorMessage?: string | null;
    retryScheduled?: boolean;
  }): Promise<{ session: AgentSessionRecord; resumptions: SessionResumeCandidate[] }> {
    const session = await this.getSessionById(input.sessionId);
    if (!session) {
      throw new AgentSessionLifecycleError('SESSION_NOT_FOUND', 404, `Session not found: ${input.sessionId}`);
    }

    const snapshot = await this.buildContextSnapshot(session, input.run);
    const now = toIsoString(this.nowFn());

    let nextStatus: AgentSessionStatus;
    let reason: SessionTransitionReason;
    if (input.outcome === 'hitl_pending') {
      nextStatus = 'suspended';
      reason = 'hitl_pending';
    } else if (input.outcome === 'failed') {
      nextStatus = input.retryScheduled ? 'suspended' : 'terminated';
      reason = input.retryScheduled ? 'run_failed_retry_pending' : 'run_final_failure';
    } else {
      nextStatus = 'idle';
      reason = 'run_completed';
    }

    const updated = await this.updateSession(session.id, this.buildStatusPatch(nextStatus, now, reason, snapshot));
    const resumptions = await this.resumeWaitingRuns(session.org_id, session.project_id, session.agent_id);

    return { session: updated, resumptions };
  }

  async transitionSession(input: {
    sessionId: string;
    orgId: string;
    projectId: string;
    actorId: string;
    status: AgentSessionStatus;
    reason?: string | null;
  }): Promise<{ session: AgentSessionRecord; resumptions: SessionResumeCandidate[] }> {
    const session = await this.getSessionById(input.sessionId);
    if (!session || session.org_id !== input.orgId || session.project_id !== input.projectId) {
      throw new AgentSessionLifecycleError('SESSION_NOT_FOUND', 404, 'Session not found');
    }

    if (input.status === 'active') {
      const activeCount = await this.countActiveSessions(session.org_id, session.project_id, session.agent_id, session.id);
      if (activeCount >= this.sessionLimit) {
        throw new AgentSessionLifecycleError('SESSION_LIMIT_REACHED', 409, 'Concurrent session limit reached');
      }
    }

    const snapshot = input.status === 'active'
      ? asRecord(session.context_snapshot)
      : await this.buildContextSnapshot(session, null);
    const updated = await this.updateSession(
      session.id,
      this.buildStatusPatch(input.status, toIsoString(this.nowFn()), 'manual_transition', snapshot, input.reason ?? null, input.actorId),
    );

    if (input.status === 'active') {
      await this.restoreContextSnapshotIfNeeded(updated);
    }

    const resumptions = input.status === 'active'
      ? await this.resumeHeldRunsForSession(updated.id)
      : await this.resumeWaitingRuns(session.org_id, session.project_id, session.agent_id);

    return { session: updated, resumptions };
  }

  async listSessions(input: {
    orgId: string;
    projectId: string;
    agentId?: string;
    status?: AgentSessionStatus;
    limit?: number;
  }): Promise<AgentSessionRecord[]> {
    let query = this.db
      .from('agent_sessions')
      .select('*')
      .eq('org_id', input.orgId)
      .eq('project_id', input.projectId)
      .is('deleted_at', null)
      .order('last_activity_at', { ascending: false });

    if (input.agentId) query = query.eq('agent_id', input.agentId);
    if (input.status) query = query.eq('status', input.status);
    if (input.limit) query = query.limit(input.limit);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as AgentSessionRecord[];
  }

  async recoverStaleRuns(): Promise<RecoverStaleSessionsResult> {
    const cutoff = new Date(this.nowFn().getTime() - this.crashTimeoutMs).toISOString();
    const { data, error } = await this.db
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, memo_id, session_id, status, retry_count, max_retries, started_at, finished_at, result_summary, last_error_code, error_message')
      .eq('status', 'running')
      .not('session_id', 'is', null)
      .not('started_at', 'is', null)
      .is('finished_at', null)
      .lte('started_at', cutoff)
      .order('started_at', { ascending: true })
      .limit(50);

    if (error) throw error;

    let recoveredCount = 0;
    let retryScheduledCount = 0;
    let terminatedCount = 0;
    let resumedCount = 0;
    const resumeCandidates: SessionResumeCandidate[] = [];

    for (const row of (data ?? []) as AgentSessionRunRecord[]) {
      if (!row.session_id) continue;

        const { error: failError } = await this.db
        .from('agent_runs')
        .update({
          status: 'failed',
          finished_at: toIsoString(this.nowFn()),
          last_error_code: 'session_crash_recovered',
          error_message: 'Running run exceeded crash timeout and entered recovery flow',
          result_summary: 'Run failed after crash recovery timeout',
          failure_disposition: null,
        })
        .eq('id', row.id);

      if (failError) throw failError;

      recoveredCount += 1;
      const retry = await this.retryService.scheduleRetry(row.id);
      if (retry.scheduled) {
        retryScheduledCount += 1;
      }

      const session = await this.getSessionById(row.session_id);
      if (session) {
        const snapshot = await this.buildContextSnapshot(session, row);
        const nextStatus: AgentSessionStatus = retry.scheduled ? 'suspended' : 'terminated';
        await this.updateSession(session.id, this.buildStatusPatch(nextStatus, toIsoString(this.nowFn()), 'crash_recovery', snapshot));
        if (!retry.scheduled) terminatedCount += 1;
        const resumptions = await this.resumeWaitingRuns(session.org_id, session.project_id, session.agent_id);
        resumedCount += resumptions.length;
        resumeCandidates.push(...resumptions);
      }
    }

    return {
      recoveredCount,
      retryScheduledCount,
      terminatedCount,
      resumedCount,
      resumeCandidates,
    };
  }

  private async getSessionByKey(orgId: string, projectId: string, agentId: string, sessionKey: string) {
    const { data, error } = await this.db
      .from('agent_sessions')
      .select('*')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('agent_id', agentId)
      .eq('session_key', sessionKey)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw error;
    return (data ?? null) as AgentSessionRecord | null;
  }

  private async getSessionById(id: string) {
    const { data, error } = await this.db
      .from('agent_sessions')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();

    if (error) throw error;
    return (data ?? null) as AgentSessionRecord | null;
  }

  private async countActiveSessions(orgId: string, projectId: string, agentId: string, excludeId: string | null) {
    let query = this.db
      .from('agent_sessions')
      .select('id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('agent_id', agentId)
      .eq('status', 'active')
      .is('deleted_at', null);

    if (excludeId) query = query.neq('id', excludeId);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).length;
  }

  private async createSession(payload: Record<string, unknown>) {
    const { data, error } = await this.db
      .from('agent_sessions')
      .insert({
        context_snapshot: {},
        ...payload,
      })
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('session_insert_failed');
    return data as AgentSessionRecord;
  }

  private async updateSession(id: string, patch: Record<string, unknown>) {
    const { error } = await this.db
      .from('agent_sessions')
      .update(patch)
      .eq('id', id);

    if (error) throw error;
    const updated = await this.getSessionById(id);
    if (!updated) throw new Error('session_update_failed');
    return updated;
  }

  private buildStatusPatch(
    status: AgentSessionStatus,
    now: string,
    reason: SessionTransitionReason,
    snapshot: Record<string, unknown>,
    note: string | null = null,
    actorId: string | null = null,
  ) {
    const metadataPatch: Record<string, unknown> = {
      transition_reason: reason,
      transition_note: note,
      transition_actor_id: actorId,
      queue_reason: status === 'active' ? null : undefined,
    };

    if (status === 'active') {
      return {
        status,
        context_snapshot: snapshot,
        last_activity_at: now,
        idle_at: null,
        suspended_at: null,
        ended_at: null,
        terminated_at: null,
        metadata: metadataPatch,
      };
    }

    if (status === 'idle') {
      return {
        status,
        context_snapshot: snapshot,
        last_activity_at: now,
        idle_at: now,
        suspended_at: null,
        ended_at: null,
        terminated_at: null,
        metadata: metadataPatch,
      };
    }

    if (status === 'suspended') {
      return {
        status,
        context_snapshot: snapshot,
        last_activity_at: now,
        idle_at: null,
        suspended_at: now,
        ended_at: null,
        terminated_at: null,
        metadata: metadataPatch,
      };
    }

    return {
      status,
      context_snapshot: snapshot,
      last_activity_at: now,
      idle_at: null,
      suspended_at: null,
      ended_at: now,
      terminated_at: now,
      metadata: metadataPatch,
    };
  }

  private async buildContextSnapshot(session: AgentSessionRecord, run: AgentSessionRunRecord | null) {
    const memories = await this.listSessionMemories({
      orgId: session.org_id,
      projectId: session.project_id,
      agentId: session.agent_id,
      sessionId: session.id,
    });
    return {
      saved_at: toIsoString(this.nowFn()),
      session_id: session.id,
      session_key: session.session_key,
      run: run
        ? {
            id: run.id,
            status: run.status,
            result_summary: run.result_summary ?? null,
            error_code: run.last_error_code ?? null,
            error_message: run.error_message ?? null,
          }
        : null,
      memories: memories.map((memory) => ({
        memory_type: memory.memory_type,
        content: memory.content,
        importance: memory.importance ?? 50,
        created_at: memory.created_at ?? toIsoString(this.nowFn()),
      } satisfies SessionSnapshotMemory)),
    };
  }

  private async listSessionMemories(scope: AgentSessionMemoryScope): Promise<SessionMemoryRow[]> {
    const { data, error } = await this.db
      .from('agent_session_memories')
      .select('id, org_id, project_id, agent_id, session_id, run_id, memory_type, importance, content, metadata, created_at')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .eq('session_id', scope.sessionId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(SNAPSHOT_MEMORY_LIMIT);

    if (error) throw error;
    const rows = (data ?? []) as SessionMemoryRow[];
    return partitionSessionMemoryRowsByScope(rows, scope).inScope;
  }

  private async restoreContextSnapshotIfNeeded(session: AgentSessionRecord) {
    const snapshot = asRecord(session.context_snapshot);
    const memories = Array.isArray(snapshot.memories) ? snapshot.memories as SessionSnapshotMemory[] : [];
    if (!memories.length) return 0;

    const existingMemories = await this.listSessionMemories({
      orgId: session.org_id,
      projectId: session.project_id,
      agentId: session.agent_id,
      sessionId: session.id,
    });
    if (existingMemories.length > 0) return 0;

    for (const memory of memories) {
      const { error } = await this.db
        .from('agent_session_memories')
        .insert(createSessionMemoryWrite({
          scope: {
            orgId: session.org_id,
            projectId: session.project_id,
            agentId: session.agent_id,
            sessionId: session.id,
          },
          runId: null,
          memoryType: memory.memory_type,
          importance: memory.importance,
          content: memory.content,
          metadata: { restored_from_snapshot: true },
        }));

      if (error) throw error;
    }

    return memories.length;
  }

  private async resumeHeldRunsForSession(sessionId: string): Promise<SessionResumeCandidate[]> {
    const { data: heldRuns, error: heldRunsError } = await this.db
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, memo_id, session_id, status, retry_count, max_retries, started_at, finished_at, result_summary, last_error_code, error_message')
      .eq('session_id', sessionId)
      .eq('status', 'held')
      .limit(1);

    if (heldRunsError) throw heldRunsError;

    const run = ((heldRuns ?? []) as AgentSessionRunRecord[])[0];
    if (!run || !run.memo_id || !run.session_id) return [];

    const { error: resumeError } = await this.db
      .from('agent_runs')
      .update({
        status: 'running',
        started_at: toIsoString(this.nowFn()),
        finished_at: null,
        last_error_code: null,
        error_message: null,
        failure_disposition: null,
        result_summary: 'Queued run resumed after session was manually reactivated',
      })
      .eq('id', run.id);

    if (resumeError) throw resumeError;

    return [{
      runId: run.id,
      memoId: run.memo_id,
      orgId: run.org_id,
      projectId: run.project_id,
      agentId: run.agent_id,
    }];
  }

  private async resumeWaitingRuns(orgId: string, projectId: string, agentId: string): Promise<SessionResumeCandidate[]> {
    let availableSlots = this.sessionLimit - await this.countActiveSessions(orgId, projectId, agentId, null);
    if (availableSlots <= 0) return [];

    const { data: heldRuns, error: heldRunsError } = await this.db
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, memo_id, session_id, status, retry_count, max_retries, started_at, finished_at, result_summary, last_error_code, error_message')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('agent_id', agentId)
      .eq('status', 'held');

    if (heldRunsError) throw heldRunsError;

    const resumptions: SessionResumeCandidate[] = [];
    const seenSessionIds = new Set<string>();

    for (const run of (heldRuns ?? []) as AgentSessionRunRecord[]) {
      if (availableSlots <= 0 || !run.session_id || !run.memo_id) break;
      if (seenSessionIds.has(run.session_id)) continue;

      const session = await this.getSessionById(run.session_id);
      if (!session || session.status !== 'idle') continue;

      const activated = await this.updateSession(
        session.id,
        this.buildStatusPatch('active', toIsoString(this.nowFn()), 'session_capacity_released', asRecord(session.context_snapshot)),
      );
      await this.restoreContextSnapshotIfNeeded(activated);

      const { error: resumeError } = await this.db
        .from('agent_runs')
        .update({
          status: 'running',
          started_at: toIsoString(this.nowFn()),
          finished_at: null,
          last_error_code: null,
          error_message: null,
          failure_disposition: null,
          result_summary: 'Queued run resumed after session capacity was freed',
        })
        .eq('id', run.id);

      if (resumeError) throw resumeError;

      resumptions.push({
        runId: run.id,
        memoId: run.memo_id,
        orgId: run.org_id,
        projectId: run.project_id,
        agentId: run.agent_id,
      });
      seenSessionIds.add(run.session_id);
      availableSlots -= 1;
    }

    return resumptions;
  }
}
