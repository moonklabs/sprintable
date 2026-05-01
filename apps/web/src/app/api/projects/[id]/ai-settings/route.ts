import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiError, apiSuccess, ApiErrors } from '@/lib/api-response';
import { buildManagedAgentFailurePatch } from '@/lib/managed-agent-contract';
import { getMyTeamMember } from '@/lib/auth-helpers';
import { requireOrgAdmin } from '@/lib/admin-check';
import { parseBody } from '@sprintable/shared';
import {
  getDefaultPersistedLLMConfig,
  parsePersistedLLMConfig,
  providerSwitchRequiresNewApiKey,
  validateCustomEndpoint,
} from '@/lib/llm/config';
import { executeKmsRotation, KmsError } from '@/lib/kms';
import {
  decryptProjectSecret,
  ensureProjectSecretEncrypted,
  getProjectAiSettingsWithIntegration,
  maskLast4,
  ORG_INTEGRATION_TYPE,
  persistProjectAiSettingsWithEncryptedSecret,
} from '@/lib/llm/project-ai-settings';
import type { LLMProvider } from '@/lib/llm';

import { isOssMode } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

const legacyMcpFields = ['mcp_servers', 'mcpServers', 'github_mcp'] as const;

function stripLegacyMcpConfig(rawConfig: unknown): Record<string, unknown> {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {};
  }

  const normalized = { ...(rawConfig as Record<string, unknown>) };
  for (const field of legacyMcpFields) {
    delete normalized[field];
  }

  return normalized;
}

const updateAiSettingsSchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'google', 'groq', 'openai-compatible']),
  api_key: z.string().trim().optional(),
  llm_config: z.object({
    model: z.string().min(1).optional(),
    baseUrl: z.string().url().optional().or(z.literal('')),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    maxRetries: z.number().int().min(0).max(3).optional(),
    mcp_servers: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
    github_mcp: z.unknown().optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.provider === 'openai-compatible' && !value.llm_config?.baseUrl?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['llm_config', 'baseUrl'],
      message: 'baseUrl is required for openai-compatible provider',
    });
  }

  if (value.llm_config?.mcp_servers !== undefined || value.llm_config?.mcpServers !== undefined || value.llm_config?.github_mcp !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['llm_config'],
      message: 'External MCP connections must be managed from approved MCP settings',
    });
  }
});

/** GET — 프로젝트 AI 설정 조회 (api_key 마스킹 + persisted llm_config) */
export async function GET(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiSuccess(null);
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { settings, integration } = await getProjectAiSettingsWithIntegration(supabase as never, id);
    if (!settings) return apiSuccess(null);

    const encryptedIntegration = await ensureProjectSecretEncrypted(supabase as never, { settings, integration });
    const provider = settings.provider as LLMProvider;
    const llmConfig = parsePersistedLLMConfig(stripLegacyMcpConfig(settings.llm_config), provider);
    const masked = maskLast4(encryptedIntegration?.secret_last4) ?? (settings.api_key ? `****${settings.api_key.slice(-4)}` : null);

    return apiSuccess({
      ...settings,
      api_key: masked,
      llm_config: llmConfig,
    });
  } catch (err: unknown) {
    if (err instanceof KmsError) return apiError('KMS_UNAVAILABLE', 'KMS 서비스 일시 오류', 503);
    return handleApiError(err);
  }
}

/** PUT — 프로젝트 AI 설정 저장 (admin only, 기존 api_key 유지 허용) */
export async function PUT(request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'AI settings persistence is not supported in OSS mode. Set API keys via environment variables.', 501);
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const parsed = await parseBody(request, updateAiSettingsSchema);
    if (!parsed.success) return parsed.response;

    const body = parsed.data;
    const normalizedBaseUrl = body.llm_config?.baseUrl?.trim()
      ? validateCustomEndpoint(body.llm_config.baseUrl, body.provider)
      : undefined;

    const { settings: existingSettings, integration: existingIntegration } = await getProjectAiSettingsWithIntegration(supabase as never, id);
    const providedApiKey = body.api_key?.trim();
    const encryptedIntegration = providedApiKey
      ? existingIntegration
      : await ensureProjectSecretEncrypted(supabase as never, {
          settings: existingSettings,
          integration: existingIntegration,
        });

    const existingProvider = existingSettings?.provider as LLMProvider | undefined;
    const requiresNewApiKey = providerSwitchRequiresNewApiKey(existingProvider, body.provider);
    const existingEncryptedSecret = providedApiKey ? null : await decryptProjectSecret(me.org_id, encryptedIntegration ?? {});
    const apiKey = providedApiKey || (requiresNewApiKey ? undefined : existingEncryptedSecret ?? existingSettings?.api_key ?? undefined);
    if (!apiKey) {
      return ApiErrors.badRequest(requiresNewApiKey ? 'api_key is required when provider changes' : 'api_key is required');
    }

    const carryForwardConfig = existingProvider === body.provider ? stripLegacyMcpConfig(existingSettings?.llm_config) : {};
    const llmConfig = parsePersistedLLMConfig({
      ...getDefaultPersistedLLMConfig(body.provider),
      ...carryForwardConfig,
      ...stripLegacyMcpConfig(body.llm_config),
      baseUrl: normalizedBaseUrl,
    }, body.provider);

    if (body.provider === 'openai-compatible' && !llmConfig.baseUrl) {
      return ApiErrors.badRequest('baseUrl is required for openai-compatible provider');
    }

    const updatedAt = new Date().toISOString();
    const { data } = await persistProjectAiSettingsWithEncryptedSecret(supabase as never, {
      orgId: me.org_id,
      projectId: id,
      provider: body.provider,
      llmConfig,
      plaintextSecret: apiKey,
      updatedAt,
    });

    return apiSuccess(data);
  } catch (err: unknown) {
    if (err instanceof KmsError) return apiError('KMS_UNAVAILABLE', 'KMS 서비스 일시 오류', 503);
    return handleApiError(err);
  }
}

/** DELETE — 프로젝트 AI 설정(BYOM 키 포함) 삭제 (admin only) */
export async function DELETE(_request: Request, { params }: RouteParams) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'AI settings are not supported in OSS mode.', 501);
  try {
    const { id } = await params;
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const me = await getMyTeamMember(supabase, user);
    if (!me) return ApiErrors.forbidden();
    await requireOrgAdmin(supabase, me.org_id);

    const rotationRequestedAt = new Date().toISOString();
    const { integration } = await getProjectAiSettingsWithIntegration(supabase as never, id);

    const { error: rotationError } = await supabase
      .from('org_integrations')
      .update({
        kms_status: 'rotation_requested',
        rotation_requested_at: rotationRequestedAt,
        updated_at: rotationRequestedAt,
      })
      .eq('org_id', me.org_id)
      .eq('project_id', id)
      .eq('integration_type', ORG_INTEGRATION_TYPE);

    if (rotationError) throw rotationError;

    const kmsRotation = integration
      ? await executeKmsRotation(me.org_id, integration.kms_provider as never)
      : null;

    const { error: deploymentError } = await supabase
      .from('agent_deployments')
      .update(buildManagedAgentFailurePatch({
        code: 'project_ai_settings_deleted',
        message: 'Project AI settings were deleted, so the managed deployment no longer has a valid credential source',
        detail: {
          project_id: id,
          rotation_requested_at: rotationRequestedAt,
        },
      }, rotationRequestedAt))
      .eq('org_id', me.org_id)
      .eq('project_id', id)
      .in('status', ['DEPLOYING', 'ACTIVE', 'SUSPENDED']);

    if (deploymentError) throw deploymentError;

    const { error: settingsDeleteError } = await supabase
      .from('project_ai_settings')
      .delete()
      .eq('project_id', id);

    if (settingsDeleteError) throw settingsDeleteError;

    const { error: integrationDeleteError } = await supabase
      .from('org_integrations')
      .delete()
      .eq('org_id', me.org_id)
      .eq('project_id', id)
      .eq('integration_type', ORG_INTEGRATION_TYPE);

    if (integrationDeleteError) throw integrationDeleteError;

    return apiSuccess({
      deleted: true,
      project_id: id,
      org_integration_deleted: true,
      kms_rotation: {
        requested: true,
        requested_at: rotationRequestedAt,
        executed: Boolean(kmsRotation),
        provider: kmsRotation?.provider ?? null,
        rotated_key_version: kmsRotation?.rotatedKeyVersion ?? null,
        executed_at: kmsRotation?.executedAt ?? null,
      },
      deployments_marked_failed: true,
    });
  } catch (err: unknown) {
    if (err instanceof KmsError) return apiError('KMS_UNAVAILABLE', 'KMS 서비스 일시 오류', 503);
    return handleApiError(err);
  }
}
