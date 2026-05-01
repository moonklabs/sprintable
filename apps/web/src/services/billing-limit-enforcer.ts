// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// OSS stub — 실제 billing 한도 집행은 @moonklabs/sprintable-saas 에 있다.
// OSS 단독 빌드에서는 한도 없음으로 enforceBeforeRun은 항상 allow 반환, enforceAfterRun은 no-op.

export interface BillingLimitSettings {
  monthlyCapCents: number | null;
  dailyCapCents: number | null;
  alertThresholdPct: number;
  source: 'explicit' | 'plan_default';
  tierName: string;
}

export interface BillingPreExecutionResult {
  status: 'allow' | 'daily_cap_exceeded' | 'monthly_cap_exceeded';
  reason: string | null;
}

export interface BillingPostExecutionResult {
  thresholdAlertSent: boolean;
  monthlyCapExceeded: boolean;
  suspendedDeploymentCount: number;
}

export interface BillingLimitsInput {
  monthlyCapCents?: number | null;
  dailyCapCents?: number | null;
  alertThresholdPct?: number;
}

interface ExecutionScope {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  memo_id: string | null;
}

interface MemoScope {
  id: string;
  title: string | null;
}

interface BillingLimitDeps {
  fetchFn?: typeof fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fireWebhooksFn?: (...args: any[]) => Promise<unknown>;
  now?: () => Date;
}

export class BillingLimitEnforcer {
  constructor(_supabase: SupabaseClient, _options?: BillingLimitDeps) {
    void _supabase;
    void _options;
  }

  async getResolvedSettings(_orgId: string): Promise<BillingLimitSettings> {
    return {
      monthlyCapCents: null,
      dailyCapCents: null,
      alertThresholdPct: 80,
      source: 'plan_default',
      tierName: 'oss',
    };
  }

  async saveSettings(_orgId: string, _input: BillingLimitsInput): Promise<BillingLimitSettings> {
    return this.getResolvedSettings(_orgId);
  }

  async enforceBeforeRun(_input: { run: ExecutionScope; memo: MemoScope }): Promise<BillingPreExecutionResult> {
    return { status: 'allow', reason: null };
  }

  async enforceAfterRun(_input: { run: ExecutionScope; memo: MemoScope }): Promise<BillingPostExecutionResult> {
    return { thresholdAlertSent: false, monthlyCapExceeded: false, suspendedDeploymentCount: 0 };
  }
}

export function createBlockedBillingPatch(code: 'daily_cap_exceeded' | 'monthly_cap_exceeded', reason: string) {
  const errorCode = code === 'daily_cap_exceeded' ? 'billing_daily_cap_exceeded' : 'billing_monthly_cap_exceeded';
  return {
    status: 'failed' as const,
    finished_at: new Date().toISOString(),
    llm_call_count: 0,
    tool_call_history: [] as unknown[],
    output_memo_ids: [] as string[],
    last_error_code: errorCode,
    error_message: reason,
    result_summary: reason,
    failure_disposition: 'non_retryable' as const,
    duration_ms: 0,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: 0,
    computed_cost_cents: 0,
    llm_provider: null,
    llm_provider_key: null,
    per_run_cap_cents: null,
    billing_notes: [errorCode],
  };
}
