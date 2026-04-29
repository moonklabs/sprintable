import { describe, expect, it } from 'vitest';
import { calculateRunBilling, type ManagedPricingRow } from './agent-run-billing';
import type { LLMProvider } from '@/lib/llm';

function pricing(provider: LLMProvider, model: string, inputRate: number, outputRate: number): ManagedPricingRow {
  return {
    provider,
    model,
    input_cost_per_million_tokens_usd: inputRate,
    output_cost_per_million_tokens_usd: outputRate,
  };
}

describe('calculateRunBilling', () => {
  it('returns zero cost for byom runs', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'byom', provider: 'openai', model: 'gpt-4o-mini', perRunCapCents: undefined },
      inputTokens: 1000,
      outputTokens: 500,
      pricingRow: pricing('openai', 'gpt-4o-mini', 0.15, 0.6),
    });

    expect(result.llmProvider).toBe('byom');
    expect(result.llmProviderKey).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.computedCostCents).toBe(0);
    expect(result.billingNotes).toContain('byom_no_charge');
  });

  it('applies managed pricing with 30 percent margin for openai', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'openai', model: 'gpt-4o', perRunCapCents: undefined },
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      pricingRow: pricing('openai', 'gpt-4o', 2.5, 10),
    });

    expect(result.llmProvider).toBe('managed');
    expect(result.llmProviderKey).toBe('openai');
    expect(result.model).toBe('gpt-4o');
    expect(result.computedCostCents).toBe(975);
    expect(result.costUsd).toBe(9.75);
  });

  it('applies managed pricing for anthropic', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'anthropic', model: 'claude-sonnet-4', perRunCapCents: undefined },
      inputTokens: 500_000,
      outputTokens: 250_000,
      pricingRow: pricing('anthropic', 'claude-sonnet-4', 3, 15),
    });

    expect(result.computedCostCents).toBe(683);
  });

  it('applies managed pricing for google', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'google', model: 'gemini-2.5-flash', perRunCapCents: undefined },
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      pricingRow: pricing('google', 'gemini-2.5-flash', 0.3, 2.5),
    });

    expect(result.computedCostCents).toBe(403);
  });

  it('applies managed pricing for groq', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'groq', model: 'llama-3.1-8b-instant', perRunCapCents: undefined },
      inputTokens: 4_000_000,
      outputTokens: 1_000_000,
      pricingRow: pricing('groq', 'llama-3.1-8b-instant', 0.05, 0.08),
    });

    expect(result.computedCostCents).toBe(37);
  });

  it('adds a fallback billing note when token usage is unavailable', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'openai', model: 'gpt-4o-mini', perRunCapCents: undefined },
      inputTokens: null,
      outputTokens: null,
      pricingRow: pricing('openai', 'gpt-4o-mini', 0.15, 0.6),
    });

    expect(result.computedCostCents).toBe(0);
    expect(result.billingNotes).toContain('token_count_unavailable');
  });

  it('falls back to default managed pricing when the model is not seeded', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'openai', model: 'unseeded-model', perRunCapCents: undefined },
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      pricingRow: null,
    });

    expect(result.computedCostCents).toBe(2600);
    expect(result.costUsd).toBe(26);
    expect(result.billingNotes).toContain('managed_pricing_missing');
    expect(result.billingNotes).toContain('managed_pricing_fallback');
  });

  it('flags cap exceedance when computed cost is above perRunCapCents', () => {
    const result = calculateRunBilling({
      llmConfig: { billingMode: 'managed', provider: 'openai', model: 'gpt-4o-mini', perRunCapCents: 100 },
      inputTokens: 100_000,
      outputTokens: 50_000,
      pricingRow: pricing('openai', 'gpt-4o-mini', 10, 30),
    });

    expect(result.capExceeded).toBe(true);
    expect(result.billingNotes).toContain('per_run_cap_exceeded');
  });
});
