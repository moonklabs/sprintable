import type {
  IAgentRunBillingRepository,
  AgentRunBilling,
  RecordAgentRunBillingInput,
  AgentRunBillingSummary,
} from '../interfaces/IAgentRunBillingRepository';

/**
 * OSS 모드 전용. record()는 in-memory no-op 레코드를 반환하고,
 * 요약은 항상 0으로 반환한다. 영구 저장 없음.
 */
export class NullAgentRunBillingRepository implements IAgentRunBillingRepository {
  async record(input: RecordAgentRunBillingInput): Promise<AgentRunBilling> {
    return {
      id: `oss-noop-${Date.now()}`,
      org_id: input.org_id,
      agent_run_id: input.agent_run_id,
      token_input: input.token_input,
      token_output: input.token_output,
      cost_usd: input.cost_usd,
      created_at: new Date().toISOString(),
    };
  }

  async getSummaryForOrg(_orgId: string, _since?: string): Promise<AgentRunBillingSummary> {
    return {
      total_runs: 0,
      total_token_input: 0,
      total_token_output: 0,
      total_cost_usd: 0,
    };
  }
}
