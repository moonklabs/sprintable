export interface AgentRunBilling {
  id: string;
  org_id: string;
  agent_run_id: string;
  token_input: number;
  token_output: number;
  cost_usd: number;
  created_at: string;
}

export interface RecordAgentRunBillingInput {
  org_id: string;
  agent_run_id: string;
  token_input: number;
  token_output: number;
  cost_usd: number;
}

export interface AgentRunBillingSummary {
  total_runs: number;
  total_token_input: number;
  total_token_output: number;
  total_cost_usd: number;
}

/**
 * SaaS-only. OSS 모드에서는 NullAgentRunBillingRepository를 사용하여
 * record()는 no-op, summary는 0으로 반환한다.
 */
export interface IAgentRunBillingRepository {
  record(input: RecordAgentRunBillingInput): Promise<AgentRunBilling>;
  getSummaryForOrg(orgId: string, since?: string): Promise<AgentRunBillingSummary>;
}
