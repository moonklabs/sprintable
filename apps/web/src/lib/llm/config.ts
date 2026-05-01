import { z } from 'zod';
import { githubMcpConfigSchema } from '@/lib/github-mcp';
import { KmsError } from '@/lib/kms';
import { mcpTokenRefSchema } from '@/lib/mcp-secrets';
import {
  decryptProjectSecret,
  ensureProjectSecretEncrypted,
  getProjectAiSettingsWithIntegration,
  matchesProjectAiCredentialProvider,
} from './project-ai-settings';
import { LLMAuthError, LLMConfigurationError } from './errors';
import { providerSwitchRequiresNewApiKey, type LLMConfig, type LLMProvider, type PersistedLLMConfig } from './types';

const DEFAULT_MODEL: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
  groq: 'llama-3.1-8b-instant',
  'openai-compatible': 'gpt-4o-mini',
};

const OPENAI_LIKE_PROVIDERS = new Set<LLMProvider>(['openai', 'groq', 'openai-compatible']);

const externalMcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  allowed_tools: z.array(z.string().min(1)).min(1),
  auth: z.object({
    token_ref: mcpTokenRefSchema,
    header_name: z.string().min(1).optional(),
    scheme: z.enum(['bearer', 'plain']).optional(),
  }).optional(),
});

const persistedLLMConfigSchema = z.object({
  model: z.string().min(1).optional(),
  baseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().positive().max(120000).optional(),
  maxRetries: z.number().int().min(0).optional(),
  perRunCapCents: z.number().int().nonnegative().max(1_000_000).optional(),
  mcp_servers: z.array(externalMcpServerSchema).optional(),
  mcpServers: z.array(externalMcpServerSchema).optional(),
  github_mcp: githubMcpConfigSchema.optional(),
});

export function getDefaultModel(provider: LLMProvider): string {
  return DEFAULT_MODEL[provider];
}

export function getDefaultPersistedLLMConfig(provider: LLMProvider): PersistedLLMConfig {
  return {
    model: getDefaultModel(provider),
    timeoutMs: 30000,
    maxRetries: 3,
  };
}

export function validateCustomEndpoint(baseUrl?: string, provider?: LLMProvider): string | undefined {
  if (!baseUrl) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LLMConfigurationError('INVALID_LLM_BASE_URL');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new LLMConfigurationError('INVALID_LLM_BASE_URL_PROTOCOL');
  }

  if (provider && OPENAI_LIKE_PROVIDERS.has(provider) && !parsed.pathname.includes('/v1')) {
    throw new LLMConfigurationError('OPENAI_BASE_URL_MUST_INCLUDE_V1');
  }

  return parsed.toString().replace(/\/$/, '');
}

export function parsePersistedLLMConfig(rawConfig: unknown, provider: LLMProvider): PersistedLLMConfig {
  const parsed = persistedLLMConfigSchema.safeParse(rawConfig ?? {});
  if (!parsed.success) {
    return getDefaultPersistedLLMConfig(provider);
  }

  return {
    model: parsed.data.model ?? getDefaultModel(provider),
    baseUrl: validateCustomEndpoint(parsed.data.baseUrl, provider),
    timeoutMs: parsed.data.timeoutMs ?? 30000,
    maxRetries: Math.min(parsed.data.maxRetries ?? 3, 3),
    perRunCapCents: parsed.data.perRunCapCents,
    mcp_servers: parsed.data.mcp_servers ?? parsed.data.mcpServers,
    github_mcp: parsed.data.github_mcp,
  };
}

export { providerSwitchRequiresNewApiKey };

function ensureProviderBaseUrl(provider: LLMProvider, baseUrl?: string): string | undefined {
  const normalized = validateCustomEndpoint(baseUrl, provider);
  if (provider === 'openai-compatible' && !normalized) {
    throw new LLMConfigurationError('OPENAI_COMPATIBLE_BASE_URL_REQUIRED');
  }
  return normalized;
}

export async function resolveLLMConfig(projectId: string, overrides?: {
  provider?: LLMProvider;
  billingMode?: 'managed' | 'byom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}) : Promise<LLMConfig | null> {
  const serviceClient = (await import('@supabase/supabase-js')).createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { settings, integration } = await getProjectAiSettingsWithIntegration(serviceClient as never, projectId);
  const persistedProvider = settings?.provider as LLMProvider | undefined;
  const provider = overrides?.provider ?? persistedProvider;

  if (provider && overrides?.billingMode === 'byom' && !matchesProjectAiCredentialProvider({ settings, integration }, provider)) {
    return null;
  }

  try {
    const encryptedIntegration = await ensureProjectSecretEncrypted(serviceClient as never, { settings, integration });
    const apiKey = overrides?.apiKey ?? (settings?.org_id ? await decryptProjectSecret(settings.org_id, encryptedIntegration ?? {}) : null) ?? settings?.api_key;

    if (provider && apiKey && overrides?.billingMode !== 'managed') {
      const persistedConfig = parsePersistedLLMConfig(settings?.llm_config, provider);
      return {
        provider,
        billingMode: 'byom',
        apiKey,
        model: overrides?.model ?? persistedConfig.model ?? getDefaultModel(provider),
        baseUrl: ensureProviderBaseUrl(provider, overrides?.baseUrl ?? persistedConfig.baseUrl),
        timeoutMs: overrides?.timeoutMs ?? persistedConfig.timeoutMs ?? 30000,
        maxRetries: Math.min(overrides?.maxRetries ?? persistedConfig.maxRetries ?? 3, 3),
        perRunCapCents: persistedConfig.perRunCapCents,
      };
    }
  } catch (error) {
    if (provider && error instanceof KmsError) {
      throw new LLMAuthError(provider, 'KMS 서비스 일시 오류');
    }
    throw error;
  }

  if (overrides?.billingMode === 'byom') {
    return null;
  }

  const envFallbacks: Array<{ provider: LLMProvider; apiKeyEnv: string; baseUrlEnv?: string }> = [
    { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { provider: 'google', apiKeyEnv: 'GOOGLE_API_KEY' },
    { provider: 'groq', apiKeyEnv: 'GROQ_API_KEY' },
    { provider: 'openai-compatible', apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY', baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL' },
  ];

  const managedFallbacks = overrides?.provider
    ? envFallbacks.filter((fallback) => fallback.provider === overrides.provider)
    : envFallbacks;

  for (const fallback of managedFallbacks) {
    const envApiKey = process.env[fallback.apiKeyEnv];
    if (!envApiKey) continue;

    const defaults = getDefaultPersistedLLMConfig(fallback.provider);
    const envBaseUrl = fallback.baseUrlEnv ? process.env[fallback.baseUrlEnv] : defaults.baseUrl;
    const baseUrl = ensureProviderBaseUrl(fallback.provider, envBaseUrl);

    return {
      provider: fallback.provider,
      billingMode: 'managed',
      apiKey: envApiKey,
      model: overrides?.model ?? defaults.model ?? getDefaultModel(fallback.provider),
      baseUrl: ensureProviderBaseUrl(fallback.provider, overrides?.baseUrl ?? baseUrl),
      timeoutMs: overrides?.timeoutMs ?? defaults.timeoutMs,
      maxRetries: Math.min(overrides?.maxRetries ?? defaults.maxRetries ?? 3, 3),
      perRunCapCents: defaults.perRunCapCents,
    };
  }

  return null;
}
