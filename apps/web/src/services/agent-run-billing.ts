
// OSS stub — 실제 과금 계산 로직은 @moonklabs/sprintable-saas 에 있다.
// OSS 단독 빌드에서는 cost=0, cap 없음으로 모든 run을 허용한다.
import type { LLMConfig, LLMProvider } from '@/lib/llm';

export interface ManagedPricingRow {
  provider: LLMProvider;
  model: string;
  input_cost_per_million_tokens_usd: number;
  output_cost_per_million_tokens_usd: number;
}

export interface RunBillingSummary {
  llmProvider: 'managed' | 'byom' | null;
  llmProviderKey: LLMProvider | null;
  model: string | null;
  computedCostCents: number;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  billingNotes: string[];
  perRunCapCents: number | null;
  capExceeded: boolean;
}

export async function getManagedPricingRow(
  _db: any,
  _provider: LLMProvider,
  _model: string,
): Promise<ManagedPricingRow | null> {
  return null;
}

export function calculateRunBilling(input: {
  llmConfig: Pick<LLMConfig, 'billingMode' | 'provider' | 'model' | 'perRunCapCents'>;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingRow?: ManagedPricingRow | null;
}): RunBillingSummary {
  return {
    llmProvider: input.llmConfig.billingMode === 'byom' ? 'byom' : null,
    llmProviderKey: input.llmConfig.provider,
    model: String(input.llmConfig.model),
    computedCostCents: 0,
    costUsd: 0,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    billingNotes: ['oss_no_charge'],
    perRunCapCents: input.llmConfig.perRunCapCents ?? null,
    capExceeded: false,
  };
}
