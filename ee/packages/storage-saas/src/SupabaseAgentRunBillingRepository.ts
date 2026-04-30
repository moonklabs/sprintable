import type { SupabaseClient } from '@supabase/supabase-js';
import type { IAgentRunBillingRepository, AgentRunBilling, RecordAgentRunBillingInput, AgentRunBillingSummary } from '@sprintable/core-storage';
import { fastapiCall } from '@sprintable/storage-supabase';

export class SupabaseAgentRunBillingRepository implements IAgentRunBillingRepository {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly accessToken: string = '',
  ) {}

  private get fastapi(): boolean { return Boolean(this.accessToken); }

  async record(input: RecordAgentRunBillingInput): Promise<AgentRunBilling> {
    if (this.fastapi) {
      return fastapiCall<AgentRunBilling>('POST', '/api/v2/billing/agent-run', this.accessToken, { body: input });
    }
    const { data, error } = await this.supabase.from('agent_run_billing').insert({
      org_id: input.org_id,
      agent_run_id: input.agent_run_id,
      input_tokens: input.token_input,
      output_tokens: input.token_output,
      cost_usd: input.cost_usd,
    }).select().single();
    if (error) throw error;
    const row = data as Record<string, unknown>;
    return {
      id: (row['id'] as string) ?? '',
      org_id: (row['org_id'] as string) ?? input.org_id,
      agent_run_id: (row['agent_run_id'] as string) ?? input.agent_run_id,
      token_input: Number(row['input_tokens'] ?? input.token_input),
      token_output: Number(row['output_tokens'] ?? input.token_output),
      cost_usd: Number(row['cost_usd'] ?? input.cost_usd),
      created_at: (row['created_at'] as string) ?? new Date().toISOString(),
    };
  }

  async getSummaryForOrg(orgId: string, since?: string): Promise<AgentRunBillingSummary> {
    if (this.fastapi) {
      return fastapiCall<AgentRunBillingSummary>('GET', '/api/v2/billing/agent-run/summary', this.accessToken, {
        query: { org_id: orgId, since },
      });
    }
    let query = this.supabase.from('agent_run_billing').select('input_tokens, output_tokens, cost_usd').eq('org_id', orgId);
    if (since) query = query.gte('created_at', since);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Array<{ input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }>;
    return {
      total_runs: rows.length,
      total_token_input: rows.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0),
      total_token_output: rows.reduce((sum, r) => sum + (r.output_tokens ?? 0), 0),
      total_cost_usd: rows.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0),
    };
  }
}
