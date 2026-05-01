import type { SupabaseClient } from '@supabase/supabase-js';

/** PM AC: 5분 → 30분 → 2시간 exponential backoff */
const BACKOFF_MINUTES = [5, 30, 120];
const RETRYABLE_ERROR_CODES = new Set([
  'llm_call_limit_exceeded',
  'session_crash_recovered',
  'session_resume_failed',
  'agent_execution_failed',
  'agent_run_persist_failed',
  'external_mcp_timeout',
  'github_mcp_gateway_timeout',
  'project_context_loader_timeout',
]);
const RETRYABLE_ERROR_PATTERNS = [/timeout/i, /timed[_ -]?out/i, /rate[_ -]?limit/i, /temporar/i, /unavailable/i, /abort/i];

export type AgentRunFailureDisposition = 'retry_scheduled' | 'retry_launched' | 'retry_exhausted' | 'non_retryable';

export interface RetryScheduleResult {
  scheduled: boolean;
  nextRetryAt: string | null;
}

export interface RetryScheduler {
  scheduleRetry(runId: string): Promise<RetryScheduleResult>;
}

export interface RetryableFailureInput {
  status?: string | null;
  retry_count?: number | null;
  max_retries?: number | null;
  next_retry_at?: string | null;
  last_error_code?: string | null;
  error_message?: string | null;
  failure_disposition?: AgentRunFailureDisposition | null;
}

export function isRetryableRuntimeFailure(input: Pick<RetryableFailureInput, 'last_error_code' | 'error_message'>): boolean {
  const code = input.last_error_code?.trim().toLowerCase() ?? '';
  const message = input.error_message?.trim().toLowerCase() ?? '';
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(code) || pattern.test(message));
}

export function resolveFailureDisposition(input: RetryableFailureInput): AgentRunFailureDisposition | null {
  if (input.status !== 'failed') return null;
  const retryCount = input.retry_count ?? 0;
  const maxRetries = input.max_retries ?? 0;
  const retryable = isRetryableRuntimeFailure(input);

  if (!retryable) return 'non_retryable';
  if (input.next_retry_at && retryCount < maxRetries) return 'retry_scheduled';
  if (retryCount >= maxRetries) return 'retry_exhausted';
  return 'non_retryable';
}

export function getFailureDisposition(input: RetryableFailureInput): AgentRunFailureDisposition | null {
  return input.failure_disposition ?? resolveFailureDisposition(input);
}

export class AgentRetryService {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * AC1+AC2: 실패한 run에 재시도 스케줄링
   * - retry_count < max_retries이면 next_retry_at 설정
   * - exponential backoff 적용 (5분/30분/2시간)
   */
  async scheduleRetry(runId: string): Promise<{ scheduled: boolean; nextRetryAt: string | null; disposition: AgentRunFailureDisposition }> {
    const { data: run, error } = await this.supabase
      .from('agent_runs')
      .select('id, retry_count, max_retries, status, last_error_code, error_message, next_retry_at')
      .eq('id', runId)
      .single();

    if (error || !run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== 'failed') return { scheduled: false, nextRetryAt: null, disposition: 'non_retryable' };

    const retryable = isRetryableRuntimeFailure(run);
    if (!retryable) {
      await this.supabase.from('agent_runs').update({ failure_disposition: 'non_retryable', next_retry_at: null }).eq('id', runId);
      return { scheduled: false, nextRetryAt: null, disposition: 'non_retryable' };
    }
    if (run.retry_count >= run.max_retries) {
      await this.supabase.from('agent_runs').update({ failure_disposition: 'retry_exhausted', next_retry_at: null }).eq('id', runId);
      return { scheduled: false, nextRetryAt: null, disposition: 'retry_exhausted' };
    }

    const backoffIdx = Math.min(run.retry_count, BACKOFF_MINUTES.length - 1);
    const delayMinutes = BACKOFF_MINUTES[backoffIdx];
    const nextRetryAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

    const { error: updateErr } = await this.supabase
      .from('agent_runs')
      .update({ next_retry_at: nextRetryAt, failure_disposition: 'retry_scheduled' })
      .eq('id', runId);

    if (updateErr) throw new Error(`Failed to schedule retry: ${updateErr.message}`);

    return { scheduled: true, nextRetryAt, disposition: 'retry_scheduled' };
  }

  /**
   * AC1: 재시도 실행 — 원본 retry_count 증가 + 새 run 생성 + 웹훅 재실행 요청
   */
  async executeRetry(runId: string): Promise<{ newRunId: string }> {
    const { data: run, error } = await this.supabase
      .from('agent_runs')
      .select('*')
      .eq('id', runId)
      .single();

    if (error || !run) throw new Error(`Run not found: ${runId}`);

    const rollbackParentLaunch = async (cause: string): Promise<never> => {
      const { error: rollbackErr } = await this.supabase
        .from('agent_runs')
        .update({
          retry_count: run.retry_count,
          next_retry_at: run.next_retry_at,
          failure_disposition: run.failure_disposition,
          result_summary: run.result_summary,
        })
        .eq('id', runId);

      if (rollbackErr) {
        throw new Error(`${cause}; rollback failed: ${rollbackErr.message}`);
      }

      throw new Error(`${cause}; parent retry state restored`);
    };

    const { error: updateErr } = await this.supabase
      .from('agent_runs')
      .update({
        retry_count: run.retry_count + 1,
        next_retry_at: null,
        failure_disposition: 'retry_launched',
        result_summary: 'Retry launched from failed run',
      })
      .eq('id', runId);

    if (updateErr) throw new Error(`Failed to update retry count: ${updateErr.message}`);

    const { data: newRun, error: insertErr } = await this.supabase
      .from('agent_runs')
      .insert({
        org_id: run.org_id,
        project_id: run.project_id,
        agent_id: run.agent_id,
        story_id: run.story_id,
        memo_id: run.memo_id,
        trigger: 'auto_retry',
        model: run.model,
        status: 'queued',
        result_summary: 'Retry queued and waiting for runtime pickup',
        parent_run_id: run.id,
        max_retries: run.max_retries,
        retry_count: run.retry_count + 1,
        failure_disposition: null,
      })
      .select('id, org_id, project_id, agent_id, story_id, memo_id, model, trigger')
      .single();

    if (insertErr || !newRun) {
      await rollbackParentLaunch(`Failed to create retry run: ${insertErr?.message ?? 'unknown error'}`);
    }

    const createdRun = newRun as NonNullable<typeof newRun>;
    const { fireWebhooks } = await import('./webhook-notify');
    await fireWebhooks(this.supabase, createdRun.org_id, {
      event: 'agent_run.retry_requested',
      data: {
        new_run_id: createdRun.id,
        original_run_id: runId,
        agent_id: createdRun.agent_id,
        story_id: createdRun.story_id,
        memo_id: createdRun.memo_id,
        model: createdRun.model,
        trigger: createdRun.trigger,
        retry_count: run.retry_count + 1,
      },
    });

    return { newRunId: createdRun.id };
  }

  async getFinalFailures(orgId: string, limit = 20) {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, agent_id, story_id, memo_id, error_message, retry_count, max_retries, created_at, last_error_code, next_retry_at, failure_disposition, status')
      .eq('org_id', orgId)
      .eq('status', 'failed')
      .order('created_at', { ascending: false })
      .limit(limit * 2);

    if (error) throw new Error(`Failed to fetch failures: ${error.message}`);
    return (data ?? []).filter((r) => {
      const disposition = getFailureDisposition(r);
      return disposition !== 'retry_scheduled' && disposition !== 'retry_launched';
    }).slice(0, limit);
  }

  async getPendingRetries(orgId: string) {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, agent_id, retry_count, max_retries, next_retry_at, error_message, org_id, last_error_code, failure_disposition, status')
      .eq('org_id', orgId)
      .eq('status', 'failed')
      .not('next_retry_at', 'is', null)
      .lte('next_retry_at', now)
      .order('next_retry_at');

    if (error) throw new Error(`Failed to fetch pending retries: ${error.message}`);
    return (data ?? []).filter((r) => getFailureDisposition(r) === 'retry_scheduled');
  }

  async getAllPendingRetries() {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, agent_id, retry_count, max_retries, next_retry_at, error_message, org_id, last_error_code, failure_disposition, status')
      .eq('status', 'failed')
      .not('next_retry_at', 'is', null)
      .lte('next_retry_at', now)
      .order('next_retry_at')
      .limit(50);

    if (error) throw new Error(`Failed to fetch all pending retries: ${error.message}`);
    return (data ?? []).filter((r) => getFailureDisposition(r) === 'retry_scheduled');
  }
}
