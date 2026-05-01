// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { ForbiddenError, NotFoundError } from './sprint';
import { fireWebhooks } from './webhook-notify';
import { syncSlackHitlRequestState } from './slack-hitl';

type HitlRequestRow = {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  deployment_id: string | null;
  session_id: string | null;
  run_id: string | null;
  requested_for: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';
  title: string;
  prompt: string;
  response_text: string | null;
  expires_at: string | null;
  expired_at: string | null;
  metadata: Record<string, unknown> | null;
};

type AgentRunRow = {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  deployment_id: string | null;
  session_id: string | null;
  story_id: string | null;
  memo_id: string | null;
  trigger: string;
  model: string | null;
  status: 'queued' | 'held' | 'running' | 'hitl_pending' | 'completed' | 'failed';
  result_summary: string | null;
  finished_at: string | null;
  last_error_code?: string | null;
  error_message?: string | null;
  max_retries?: number;
  retry_count?: number;
};

type HitlAction = 'approve' | 'reject';

type Compensation = () => Promise<void>;

export class HitlConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HitlConflictError';
  }
}

export class AgentHitlService {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly options: {
      fireWebhooksFn?: typeof fireWebhooks;
      syncSlackHitlFn?: typeof syncSlackHitlRequestState;
      logger?: Pick<Console, 'warn' | 'error'>;
    } = {},
  ) {}

  async respond(input: {
    requestId: string;
    actorId: string;
    orgId: string;
    projectId: string;
    action: HitlAction;
    comment?: string | null;
  }) {
    const request = await this.getRequest(input.requestId, input.orgId, input.projectId);
    if (request.requested_for !== input.actorId) {
      throw new ForbiddenError('HITL request is not assigned to the current admin');
    }
    if (request.status !== 'pending') {
      throw new HitlConflictError('HITL request already processed');
    }

    const responseText = this.normalizeResponseText(input.action, input.comment);
    const metadata = (request.metadata ?? {}) as Record<string, unknown>;
    const hitlMemoId = this.asUuid(metadata.hitl_memo_id);
    const sourceMemoId = this.asUuid(metadata.source_memo_id ?? metadata.memo_id);
    if (!hitlMemoId) throw new Error('HITL memo metadata missing');

    const run = await this.getRun(request.run_id, input.orgId, input.projectId);
    if (run.status !== 'hitl_pending') {
      throw new HitlConflictError('Only hitl_pending runs can be resolved');
    }

    const resolvedSourceMemoId = sourceMemoId ?? run.memo_id;
    if (!resolvedSourceMemoId) throw new Error('Source memo missing for HITL request');

    const now = new Date().toISOString();
    const finalStatus = input.action === 'approve' ? 'approved' : 'rejected';
    const claimed = await this.claimRequest(request.id, input.actorId, finalStatus, responseText, now);
    if (!claimed) {
      throw new HitlConflictError('HITL request already processed');
    }

    const compensations: Compensation[] = [
      async () => {
        await this.supabase
          .from('agent_hitl_requests')
          .update({
            status: 'pending',
            response_text: null,
            responded_by: null,
            responded_at: null,
          })
          .eq('id', request.id);
      },
    ];

    try {
      const hitlReplyId = await this.insertMemoReply(
        hitlMemoId,
        input.actorId,
        this.buildHitlMemoReply(input.action, responseText, request),
        input.action === 'approve' ? 'approve' : 'reject',
      );
      compensations.unshift(async () => {
        await this.supabase.from('memo_replies').delete().eq('id', hitlReplyId);
      });

      compensations.unshift(async () => {
        await this.supabase
          .from('memos')
          .update({ status: 'open', resolved_by: null, resolved_at: null })
          .eq('id', hitlMemoId);
      });
      await this.resolveHitlMemo(hitlMemoId, input.actorId, input.orgId, input.projectId, now);

      if (input.action === 'approve') {
        compensations.unshift(async () => {
          await this.supabase
            .from('agent_runs')
            .update({
              status: run.status,
              result_summary: run.result_summary,
              finished_at: run.finished_at,
              last_error_code: run.last_error_code ?? null,
              error_message: run.error_message ?? null,
            })
            .eq('id', run.id);
        });
        await this.transitionRunFromHitl(run, {
          status: 'completed',
          result_summary: 'HITL approved, preparing resume',
          finished_at: now,
          last_error_code: null,
          error_message: null,
        });

        const resumedRun = await this.createResumedRun(run);
        compensations.unshift(async () => {
          await this.supabase.from('agent_runs').delete().eq('id', resumedRun.id);
        });

        const sourceReplyId = await this.insertMemoReply(
          resolvedSourceMemoId,
          input.actorId,
          [
            'HITL 승인 완료.',
            '',
            `재개 run ID: ${resumedRun.id}`,
            `검토 메모: ${hitlMemoId}`,
            responseText !== '승인' ? `관리자 코멘트: ${responseText}` : null,
          ].filter(Boolean).join('\n'),
          'comment',
        );
        compensations.unshift(async () => {
          await this.supabase.from('memo_replies').delete().eq('id', sourceReplyId);
        });

        await (this.options.fireWebhooksFn ?? fireWebhooks)(this.supabase, input.orgId, {
          event: 'agent_run.retry_requested',
          data: {
            new_run_id: resumedRun.id,
            original_run_id: run.id,
            agent_id: resumedRun.agent_id,
            story_id: resumedRun.story_id,
            memo_id: resumedRun.memo_id,
            model: resumedRun.model,
            trigger: resumedRun.trigger,
            retry_count: run.retry_count ?? 0,
          },
        });

        await this.insertAuditLog({
          request,
          actorId: input.actorId,
          runId: run.id,
          summary: 'HITL request approved',
          eventType: 'agent_hitl_request.approved',
          payload: {
            resumed_run_id: resumedRun.id,
            source_memo_id: resolvedSourceMemoId,
            hitl_memo_id: hitlMemoId,
          },
        });

        await this.syncSlackStateBestEffort({
          ...request,
          status: 'approved',
          response_text: responseText,
        }, hitlMemoId, resolvedSourceMemoId, input.actorId);

        return {
          id: request.id,
          status: 'approved' as const,
          resumed_run_id: resumedRun.id,
          source_memo_id: resolvedSourceMemoId,
          hitl_memo_id: hitlMemoId,
        };
      }

      compensations.unshift(async () => {
        await this.supabase
          .from('agent_runs')
          .update({
            status: run.status,
            result_summary: run.result_summary,
            finished_at: run.finished_at,
            last_error_code: run.last_error_code ?? null,
            error_message: run.error_message ?? null,
          })
          .eq('id', run.id);
      });
      await this.transitionRunFromHitl(run, {
        status: 'failed',
        result_summary: 'HITL rejected by admin',
        finished_at: now,
        last_error_code: 'hitl_rejected',
        error_message: responseText,
      });

      const sourceReplyId = await this.insertMemoReply(
        resolvedSourceMemoId,
        input.actorId,
        [
          'HITL 거부로 실행 종료.',
          '',
          `거부 사유: ${responseText}`,
          `검토 메모: ${hitlMemoId}`,
        ].join('\n'),
        'comment',
      );
      compensations.unshift(async () => {
        await this.supabase.from('memo_replies').delete().eq('id', sourceReplyId);
      });

      await this.insertAuditLog({
        request,
        actorId: input.actorId,
        runId: run.id,
        summary: 'HITL request rejected',
        eventType: 'agent_hitl_request.rejected',
        payload: {
          source_memo_id: resolvedSourceMemoId,
          hitl_memo_id: hitlMemoId,
          rejection_reason: responseText,
        },
      });

      await this.syncSlackStateBestEffort({
        ...request,
        status: 'rejected',
        response_text: responseText,
      }, hitlMemoId, resolvedSourceMemoId, input.actorId);

      return {
        id: request.id,
        status: 'rejected' as const,
        resumed_run_id: null,
        source_memo_id: resolvedSourceMemoId,
        hitl_memo_id: hitlMemoId,
      };
    } catch (error) {
      await this.rollback(compensations);
      throw error;
    }
  }

  private async getRequest(requestId: string, orgId: string, projectId: string) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .select('id, org_id, project_id, agent_id, deployment_id, session_id, run_id, requested_for, status, title, prompt, response_text, expires_at, expired_at, metadata')
      .eq('id', requestId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error || !data) throw new NotFoundError('HITL request not found');
    return data as HitlRequestRow;
  }

  private async getRun(runId: string | null, orgId: string, projectId: string) {
    if (!runId) throw new Error('HITL request run missing');
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, deployment_id, session_id, story_id, memo_id, trigger, model, status, result_summary, finished_at, last_error_code, error_message, max_retries, retry_count')
      .eq('id', runId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .maybeSingle();

    if (error || !data) throw new NotFoundError('Agent run not found');
    return data as AgentRunRow;
  }

  private async claimRequest(
    requestId: string,
    actorId: string,
    status: 'approved' | 'rejected',
    responseText: string,
    respondedAt: string,
  ) {
    const { data, error } = await this.supabase
      .from('agent_hitl_requests')
      .update({
        status,
        response_text: responseText,
        responded_by: actorId,
        responded_at: respondedAt,
      })
      .eq('id', requestId)
      .eq('requested_for', actorId)
      .eq('status', 'pending')
      .is('expired_at', null)
      .select('id')
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  private async resolveHitlMemo(
    memoId: string,
    actorId: string,
    orgId: string,
    projectId: string,
    resolvedAt: string,
  ) {
    const { data, error } = await this.supabase
      .from('memos')
      .update({ status: 'resolved', resolved_by: actorId, resolved_at: resolvedAt })
      .eq('id', memoId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('status', 'open')
      .select('id')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new HitlConflictError('HITL memo is not open');
    return data;
  }

  private async transitionRunFromHitl(
    run: AgentRunRow,
    update: {
      status: 'completed' | 'failed';
      result_summary: string;
      finished_at: string;
      last_error_code: string | null;
      error_message: string | null;
    },
  ) {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .update(update)
      .eq('id', run.id)
      .eq('org_id', run.org_id)
      .eq('project_id', run.project_id)
      .eq('status', 'hitl_pending')
      .select('id, status')
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new HitlConflictError('Original run is no longer hitl_pending');
    return data;
  }

  private async createResumedRun(run: AgentRunRow) {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .insert({
        org_id: run.org_id,
        project_id: run.project_id,
        agent_id: run.agent_id,
        deployment_id: run.deployment_id,
        session_id: run.session_id,
        story_id: run.story_id,
        memo_id: run.memo_id,
        trigger: 'hitl_resume',
        model: run.model,
        status: 'running',
        parent_run_id: run.id,
        max_retries: run.max_retries ?? 3,
        retry_count: run.retry_count ?? 0,
      })
      .select('id, agent_id, story_id, memo_id, model, trigger')
      .single();

    if (error || !data) throw error ?? new Error('Failed to create resumed run');
    return data as {
      id: string;
      agent_id: string;
      story_id: string | null;
      memo_id: string | null;
      model: string | null;
      trigger: string;
    };
  }

  private async insertMemoReply(memoId: string, createdBy: string, content: string, reviewType: string) {
    const { data, error } = await this.supabase
      .from('memo_replies')
      .insert({
        memo_id: memoId,
        created_by: createdBy,
        content,
        review_type: reviewType,
      })
      .select('id')
      .single();

    if (error || !data) throw error ?? new Error('Failed to create memo reply');
    return data.id as string;
  }

  private async insertAuditLog(input: {
    request: HitlRequestRow;
    actorId: string;
    runId: string;
    summary: string;
    eventType: string;
    payload: Record<string, unknown>;
  }) {
    const { error } = await this.supabase
      .from('agent_audit_logs')
      .insert({
        org_id: input.request.org_id,
        project_id: input.request.project_id,
        agent_id: input.request.agent_id,
        deployment_id: input.request.deployment_id,
        session_id: input.request.session_id,
        run_id: input.runId,
        event_type: input.eventType,
        severity: 'info',
        summary: input.summary,
        payload: {
          hitl_request_id: input.request.id,
          requested_for: input.request.requested_for,
          ...input.payload,
        },
        created_by: input.actorId,
      });

    if (error) {
      this.options.logger?.error?.(`[AgentHitlService] audit log failed: ${error.message}`);
    }
  }

  private async rollback(compensations: Compensation[]) {
    const failures: string[] = [];
    for (const compensate of compensations) {
      try {
        await compensate();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : 'rollback_failed');
      }
    }

    if (failures.length > 0) {
      this.options.logger?.error?.(`[AgentHitlService] rollback failed: ${failures.join(', ')}`);
    }
  }

  private async syncSlackStateBestEffort(
    request: HitlRequestRow,
    hitlMemoId: string,
    sourceMemoId: string,
    actorId: string,
  ) {
    try {
      await (this.options.syncSlackHitlFn ?? syncSlackHitlRequestState)(this.supabase, {
        request,
        hitlMemoId,
        sourceMemoId,
        actorId,
      }, {
        appUrl: process.env.NEXT_PUBLIC_APP_URL,
        logger: this.options.logger,
      });
    } catch (error) {
      this.options.logger?.error?.(`[AgentHitlService] slack sync failed: ${error instanceof Error ? error.message : 'unknown_error'}`);
    }
  }

  private normalizeResponseText(action: HitlAction, comment?: string | null) {
    const trimmed = comment?.trim();
    if (action === 'reject') {
      if (!trimmed) throw new Error('Rejection reason is required');
      return trimmed;
    }
    return trimmed || '승인';
  }

  private buildHitlMemoReply(action: HitlAction, responseText: string, request: HitlRequestRow) {
    if (action === 'approve') {
      return [
        '[HITL 승인]',
        '',
        `요청: ${request.title}`,
        `응답: ${responseText}`,
      ].join('\n');
    }

    return [
      '[HITL 거부]',
      '',
      `요청: ${request.title}`,
      `거부 사유: ${responseText}`,
    ].join('\n');
  }

  private asUuid(value: unknown) {
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
