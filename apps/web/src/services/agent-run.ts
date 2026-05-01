// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;


const BACKOFF_MINUTES = [5, 30, 120] as const;

export function calculateNextRetryAt(retryCount: number): string {
  const idx = Math.min(retryCount, BACKOFF_MINUTES.length - 1);
  const delayMin = BACKOFF_MINUTES[idx];
  return new Date(Date.now() + delayMin * 60 * 1000).toISOString();
}

export interface AgentRunRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  trigger: string;
  metadata: Record<string, unknown>;
  model: string | null;
  story_id: string | null;
  memo_id: string | null;
  result_summary: string | null;
  status: 'running' | 'completed' | 'failed';
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  parent_run_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface CreateAgentRunInput {
  org_id: string;
  project_id: string;
  agent_id: string;
  trigger: string;
  metadata?: Record<string, unknown>;
  model?: string | null;
  story_id?: string | null;
  memo_id?: string | null;
  result_summary?: string | null;
  status?: 'running' | 'completed' | 'failed';
  error_message?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface UpdateAgentRunInput {
  status: 'running' | 'completed' | 'failed';
  error_message?: string | null;
  result_summary?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export type AgentRunWithRetry = AgentRunRecord & {
  auto_retry_scheduled?: boolean;
  final_failure?: boolean;
};

export class AgentRunService {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateAgentRunInput): Promise<AgentRunWithRetry> {
    const runStatus = input.status ?? 'completed';
    const terminalNow =
      runStatus === 'completed' || runStatus === 'failed' ? new Date().toISOString() : null;

    const { data, error } = await this.supabase
      .from('agent_runs')
      .insert({
        org_id: input.org_id,
        project_id: input.project_id,
        agent_id: input.agent_id,
        trigger: input.trigger,
        metadata: input.metadata ?? {},
        model: input.model ?? null,
        story_id: input.story_id ?? null,
        memo_id: input.memo_id ?? null,
        result_summary: input.result_summary ?? null,
        status: runStatus,
        error_message: input.error_message ?? null,
        input_tokens: input.input_tokens ?? null,
        output_tokens: input.output_tokens ?? null,
        started_at: input.started_at ?? new Date().toISOString(),
        finished_at: input.finished_at ?? terminalNow,
      })
      .select()
      .single();

    if (error || !data) throw new Error(error?.message ?? 'Insert failed');

    if (runStatus === 'failed') {
      return this.scheduleRetryIfNeeded(data as AgentRunRecord);
    }
    return data as AgentRunRecord;
  }

  async update(
    id: string,
    input: UpdateAgentRunInput,
    orgId: string,
    projectId: string,
  ): Promise<AgentRunWithRetry> {
    const updates: Record<string, unknown> = { status: input.status };
    if (input.error_message !== undefined) updates.error_message = input.error_message;
    if (input.result_summary !== undefined) updates.result_summary = input.result_summary;
    if (input.input_tokens !== undefined) updates.input_tokens = input.input_tokens;
    if (input.output_tokens !== undefined) updates.output_tokens = input.output_tokens;
    if (input.cost_usd !== undefined) updates.cost_usd = input.cost_usd;
    if (input.started_at !== undefined) updates.started_at = input.started_at;
    if (input.finished_at !== undefined) updates.finished_at = input.finished_at;
    if (
      (input.status === 'completed' || input.status === 'failed') &&
      input.finished_at === undefined
    ) {
      updates.finished_at = new Date().toISOString();
    }

    const { data, error } = await this.supabase
      .from('agent_runs')
      .update(updates)
      .eq('id', id)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .select(
        'id, org_id, agent_id, project_id, status, retry_count, max_retries, parent_run_id, next_retry_at, error_message, result_summary, input_tokens, output_tokens, cost_usd, started_at, finished_at, created_at, trigger, model, story_id, memo_id',
      )
      .single();

    if (error) throw new Error(`Update failed: ${error.message}`);
    if (!data) throw new Error('Run not found');

    if (input.status === 'failed') {
      return this.scheduleRetryIfNeeded(data as AgentRunRecord);
    }
    return data as AgentRunRecord;
  }

  async list(projectId: string, limit = 20, agentId?: string, cursor?: string): Promise<AgentRunRecord[]> {
    let query = this.supabase
      .from('agent_runs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (agentId) query = query.eq('agent_id', agentId);
    if (cursor) query = query.lt('created_at', cursor);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as AgentRunRecord[];
  }

  private async scheduleRetryIfNeeded(run: AgentRunRecord): Promise<AgentRunWithRetry> {
    const retryCount = run.retry_count ?? 0;
    const maxRetries = run.max_retries ?? 3;

    if (retryCount < maxRetries) {
      const nextRetryAt = calculateNextRetryAt(retryCount);
      const { error } = await this.supabase
        .from('agent_runs')
        .update({ next_retry_at: nextRetryAt })
        .eq('id', run.id);
      if (error) throw new Error(`Failed to schedule retry: ${error.message}`);
      return { ...run, next_retry_at: nextRetryAt, auto_retry_scheduled: true };
    }

    return { ...run, final_failure: true };
  }
}
