import type { SupabaseClient } from '@supabase/supabase-js';
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

const BILLING_MARGIN_MULTIPLIER = 1.3;
const DEFAULT_FALLBACK_INPUT_COST_PER_MILLION_USD = 5;
const DEFAULT_FALLBACK_OUTPUT_COST_PER_MILLION_USD = 15;

export async function getManagedPricingRow(
  supabase: SupabaseClient,
  provider: LLMProvider,
  model: string,
): Promise<ManagedPricingRow | null> {
  const { data, error } = await supabase
    .from('llm_pricing_config')
    .select('provider, model, input_cost_per_million_tokens_usd, output_cost_per_million_tokens_usd')
    .eq('provider', provider)
    .eq('model', model)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as ManagedPricingRow | null;
}

export function calculateRunBilling(input: {
  llmConfig: Pick<LLMConfig, 'billingMode' | 'provider' | 'model' | 'perRunCapCents'>;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingRow?: ManagedPricingRow | null;
}): RunBillingSummary {
  const notes: string[] = [];
  const perRunCapCents = input.llmConfig.perRunCapCents ?? null;

  if (input.llmConfig.billingMode === 'byom') {
    notes.push('byom_no_charge');
    return {
      llmProvider: 'byom',
      llmProviderKey: input.llmConfig.provider,
      model: String(input.llmConfig.model),
      computedCostCents: 0,
      costUsd: 0,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      billingNotes: notes,
      perRunCapCents,
      capExceeded: false,
    };
  }

  if (input.inputTokens == null || input.outputTokens == null) {
    notes.push('token_count_unavailable');
    return {
      llmProvider: 'managed',
      llmProviderKey: input.llmConfig.provider,
      model: String(input.llmConfig.model),
      computedCostCents: 0,
      costUsd: 0,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      billingNotes: notes,
      perRunCapCents,
      capExceeded: false,
    };
  }

  const pricingRow = input.pricingRow ?? {
    provider: input.llmConfig.provider,
    model: String(input.llmConfig.model),
    input_cost_per_million_tokens_usd: DEFAULT_FALLBACK_INPUT_COST_PER_MILLION_USD,
    output_cost_per_million_tokens_usd: DEFAULT_FALLBACK_OUTPUT_COST_PER_MILLION_USD,
  } satisfies ManagedPricingRow;

  if (!input.pricingRow) {
    notes.push('managed_pricing_missing', 'managed_pricing_fallback');
  }

  const rawCostUsd = (
    (input.inputTokens * pricingRow.input_cost_per_million_tokens_usd)
    + (input.outputTokens * pricingRow.output_cost_per_million_tokens_usd)
  ) / 1_000_000;
  const managedCostUsd = rawCostUsd * BILLING_MARGIN_MULTIPLIER;
  const computedCostCents = Math.ceil(managedCostUsd * 100);
  const capExceeded = perRunCapCents != null && computedCostCents > perRunCapCents;

  if (capExceeded) {
    notes.push('per_run_cap_exceeded');
  }

  return {
    llmProvider: 'managed',
    llmProviderKey: input.llmConfig.provider,
    model: String(input.llmConfig.model),
    computedCostCents,
    costUsd: Number((computedCostCents / 100).toFixed(2)),
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    billingNotes: notes,
    perRunCapCents,
    capExceeded,
  };
}
