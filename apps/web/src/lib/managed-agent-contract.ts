import { z } from 'zod';
import { LLM_PROVIDERS, type LLMProvider } from '@/lib/llm/types';

const llmProviderSchema = z.enum(LLM_PROVIDERS as [LLMProvider, ...LLMProvider[]]);

export const managedAgentRuntimeSchema = z.enum(['webhook', 'openclaw']);
export type ManagedAgentRuntime = z.infer<typeof managedAgentRuntimeSchema>;

export const managedAgentRegistrationConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  registration_kind: z.literal('managed').default('managed'),
  default_runtime: managedAgentRuntimeSchema.default('webhook'),
}).strict();
export type ManagedAgentRegistrationConfig = z.infer<typeof managedAgentRegistrationConfigSchema>;

export const managedAgentDeploymentModeSchema = z.enum(['managed', 'byom']);
export type ManagedAgentDeploymentMode = z.infer<typeof managedAgentDeploymentModeSchema>;

export const managedAgentDeploymentScopeSchema = z.enum(['org', 'projects']);
export type ManagedAgentDeploymentScope = z.infer<typeof managedAgentDeploymentScopeSchema>;

export const MANAGED_AGENT_DEPLOYMENT_VERIFICATION_CHECKPOINTS = [
  'dashboard_active',
  'routing_reviewed',
  'mcp_reviewed',
] as const;
export const managedAgentDeploymentVerificationCheckpointSchema = z.enum(MANAGED_AGENT_DEPLOYMENT_VERIFICATION_CHECKPOINTS);
export type ManagedAgentDeploymentVerificationCheckpoint = z.infer<typeof managedAgentDeploymentVerificationCheckpointSchema>;

export const managedAgentDeploymentVerificationStatusSchema = z.enum(['pending', 'completed']);
export type ManagedAgentDeploymentVerificationStatus = z.infer<typeof managedAgentDeploymentVerificationStatusSchema>;

export const managedAgentDeploymentVerificationSchema = z.object({
  status: managedAgentDeploymentVerificationStatusSchema.default('pending'),
  required_checkpoints: z.array(managedAgentDeploymentVerificationCheckpointSchema).default([...MANAGED_AGENT_DEPLOYMENT_VERIFICATION_CHECKPOINTS]),
  completed_at: z.string().datetime().nullable().optional(),
  completed_by: z.string().trim().min(1).nullable().optional(),
}).strict();
export type ManagedAgentDeploymentVerification = z.infer<typeof managedAgentDeploymentVerificationSchema>;

export const managedAgentDeploymentConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  llm_mode: managedAgentDeploymentModeSchema,
  provider: llmProviderSchema,
  scope_mode: managedAgentDeploymentScopeSchema.default('projects'),
  project_ids: z.array(z.string().trim().min(1)).default([]),
  verification: managedAgentDeploymentVerificationSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.scope_mode === 'projects' && value.project_ids.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['project_ids'],
      message: 'project_ids required when scope_mode is projects',
    });
  }
});
export type ManagedAgentDeploymentConfig = z.infer<typeof managedAgentDeploymentConfigSchema>;

export const managedAgentDeploymentFailureSchema = z.object({
  code: z.string().trim().min(1).max(120),
  message: z.string().trim().min(1).max(500),
  detail: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ManagedAgentDeploymentFailure = z.infer<typeof managedAgentDeploymentFailureSchema>;

export const createManagedAgentDeploymentSchema = z.object({
  agent_id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  runtime: managedAgentRuntimeSchema.optional(),
  model: z.string().trim().min(1).max(120).optional().nullable(),
  version: z.string().trim().min(1).max(80).optional().nullable(),
  persona_id: z.string().uuid().optional().nullable(),
  config: managedAgentDeploymentConfigSchema,
  overwrite_routing_rules: z.boolean().optional(),
});
export type CreateManagedAgentDeploymentInput = z.infer<typeof createManagedAgentDeploymentSchema>;

export const patchManagedAgentDeploymentSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
  }),
  z.object({
    status: z.literal('DEPLOY_FAILED'),
    failure: managedAgentDeploymentFailureSchema.optional(),
  }),
]);
export type PatchManagedAgentDeploymentInput = z.infer<typeof patchManagedAgentDeploymentSchema>;

export function buildManagedAgentDeploymentVerification(input?: Partial<ManagedAgentDeploymentVerification>): ManagedAgentDeploymentVerification {
  return managedAgentDeploymentVerificationSchema.parse({
    status: input?.status ?? 'pending',
    required_checkpoints: input?.required_checkpoints ?? [...MANAGED_AGENT_DEPLOYMENT_VERIFICATION_CHECKPOINTS],
    completed_at: input?.completed_at ?? null,
    completed_by: input?.completed_by ?? null,
  });
}

export function buildManagedAgentRegistrationConfig(input?: Partial<ManagedAgentRegistrationConfig>): ManagedAgentRegistrationConfig {
  return managedAgentRegistrationConfigSchema.parse({
    schema_version: 1,
    registration_kind: 'managed',
    default_runtime: input?.default_runtime ?? 'webhook',
  });
}

export function buildManagedAgentDeploymentConfig(input: {
  llmMode: ManagedAgentDeploymentMode;
  provider: LLMProvider;
  scopeMode: ManagedAgentDeploymentScope;
  projectIds: string[];
  verification?: Partial<ManagedAgentDeploymentVerification>;
}): ManagedAgentDeploymentConfig {
  return managedAgentDeploymentConfigSchema.parse({
    schema_version: 1,
    llm_mode: input.llmMode,
    provider: input.provider,
    scope_mode: input.scopeMode,
    project_ids: [...new Set(input.projectIds)],
    verification: buildManagedAgentDeploymentVerification(input.verification),
  });
}

export function parseManagedAgentDeploymentConfig(raw: unknown): ManagedAgentDeploymentConfig | null {
  const parsed = managedAgentDeploymentConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function normalizeManagedAgentDeploymentConfig(config: ManagedAgentDeploymentConfig): ManagedAgentDeploymentConfig {
  return managedAgentDeploymentConfigSchema.parse({
    ...config,
    project_ids: [...new Set(config.project_ids)],
    verification: buildManagedAgentDeploymentVerification(config.verification),
  });
}

export function markManagedAgentDeploymentVerificationCompleted(
  config: ManagedAgentDeploymentConfig,
  completedBy: string,
  completedAt: string = new Date().toISOString(),
): ManagedAgentDeploymentConfig {
  return normalizeManagedAgentDeploymentConfig({
    ...config,
    verification: buildManagedAgentDeploymentVerification({
      ...config.verification,
      status: 'completed',
      completed_at: completedAt,
      completed_by: completedBy,
    }),
  });
}

export function resolveManagedAgentAllowedProjectIds(
  config: ManagedAgentDeploymentConfig | null | undefined,
  fallbackProjectId: string,
): string[] {
  const ids = config?.project_ids?.length ? config.project_ids : [fallbackProjectId];
  return [...new Set(ids.filter(Boolean))];
}

export function buildManagedAgentFailurePatch(
  failure: ManagedAgentDeploymentFailure,
  failedAt: string = new Date().toISOString(),
) {
  return {
    status: 'DEPLOY_FAILED' as const,
    failure_code: failure.code,
    failure_message: failure.message,
    failure_detail: failure.detail ?? {},
    failed_at: failedAt,
    updated_at: failedAt,
  };
}

export function clearManagedAgentFailurePatch(updatedAt: string = new Date().toISOString()) {
  return {
    failure_code: null,
    failure_message: null,
    failure_detail: null,
    failed_at: null,
    updated_at: updatedAt,
  };
}
