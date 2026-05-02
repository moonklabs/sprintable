
import { z } from 'zod';
import type { SupabaseClient } from '@/types/supabase';

export const HITL_HIGH_RISK_ACTION_KEYS = [
  'destructive_change',
  'external_side_effect',
  'credential_or_billing_change',
] as const;
export type HitlHighRiskActionKey = (typeof HITL_HIGH_RISK_ACTION_KEYS)[number];

export const HITL_APPROVAL_RULE_KEYS = [
  'manual_hitl_request',
  'billing_cap_exceeded',
] as const;
export type HitlApprovalRuleKey = (typeof HITL_APPROVAL_RULE_KEYS)[number];

export const HITL_TIMEOUT_CLASS_KEYS = [
  'fast',
  'standard',
  'extended',
] as const;
export type HitlTimeoutClassKey = (typeof HITL_TIMEOUT_CLASS_KEYS)[number];

export const HITL_REQUEST_TYPES = ['approval'] as const;
export type HitlRequestType = (typeof HITL_REQUEST_TYPES)[number];

export const HITL_ESCALATION_MODES = ['timeout_memo', 'timeout_memo_and_escalate'] as const;
export type HitlEscalationMode = (typeof HITL_ESCALATION_MODES)[number];

const LEGACY_HITL_REQUEST_TYPES = ['approval', 'input', 'confirmation', 'escalation'] as const;
const hitlRequestTypeSchema = z.enum(HITL_REQUEST_TYPES);
const legacyHitlRequestTypeSchema = z.enum(LEGACY_HITL_REQUEST_TYPES);
const hitlApprovalRuleKeySchema = z.enum(HITL_APPROVAL_RULE_KEYS);
const hitlTimeoutClassKeySchema = z.enum(HITL_TIMEOUT_CLASS_KEYS);
const hitlEscalationModeSchema = z.enum(HITL_ESCALATION_MODES);

export interface HitlHighRiskActionCatalogItem {
  key: HitlHighRiskActionKey;
  severity: 'high' | 'critical';
  default_request_type: HitlRequestType;
  default_timeout_class: HitlTimeoutClassKey;
  prompt_label: string;
}

export interface HitlApprovalRule {
  key: HitlApprovalRuleKey;
  request_type: HitlRequestType;
  timeout_class: HitlTimeoutClassKey;
  approval_required: true;
}

export interface HitlTimeoutClass {
  key: HitlTimeoutClassKey;
  duration_minutes: number;
  reminder_minutes_before: number;
  escalation_mode: HitlEscalationMode;
}

const hitlApprovalRuleSchema = z.object({
  key: hitlApprovalRuleKeySchema,
  request_type: hitlRequestTypeSchema,
  timeout_class: hitlTimeoutClassKeySchema,
  approval_required: z.literal(true).default(true),
}).strict();

const persistedHitlApprovalRuleSchema = z.object({
  key: hitlApprovalRuleKeySchema,
  request_type: legacyHitlRequestTypeSchema.default('approval'),
  timeout_class: hitlTimeoutClassKeySchema,
  approval_required: z.literal(true).default(true),
}).strict();

const hitlTimeoutClassSchema = z.object({
  key: hitlTimeoutClassKeySchema,
  duration_minutes: z.number().int().min(15).max(7 * 24 * 60),
  reminder_minutes_before: z.number().int().min(5).max(24 * 60),
  escalation_mode: hitlEscalationModeSchema,
}).superRefine((value, ctx) => {
  if (value.reminder_minutes_before >= value.duration_minutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reminder_minutes_before'],
      message: 'reminder must be earlier than timeout',
    });
  }
}).strict();

const persistedHitlPolicyConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  approval_rules: z.array(persistedHitlApprovalRuleSchema).default([]),
  timeout_classes: z.array(hitlTimeoutClassSchema).default([]),
}).strict();

const saveHitlPolicyConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  approval_rules: z.array(hitlApprovalRuleSchema).default([]),
  timeout_classes: z.array(hitlTimeoutClassSchema).default([]),
}).strict();

export type PersistedHitlPolicyConfig = z.infer<typeof saveHitlPolicyConfigSchema>;

export interface HitlPolicySnapshot {
  schema_version: 1;
  high_risk_actions: HitlHighRiskActionCatalogItem[];
  approval_rules: HitlApprovalRule[];
  timeout_classes: HitlTimeoutClass[];
  prompt_summary: string;
}

const HIGH_RISK_ACTION_CATALOG: HitlHighRiskActionCatalogItem[] = [
  {
    key: 'destructive_change',
    severity: 'critical',
    default_request_type: 'approval',
    default_timeout_class: 'fast',
    prompt_label: 'Destructive memo/story resolution, deletion, or irreversible state change',
  },
  {
    key: 'external_side_effect',
    severity: 'high',
    default_request_type: 'approval',
    default_timeout_class: 'standard',
    prompt_label: 'Outbound write to external systems, public channels, or third-party tools',
  },
  {
    key: 'credential_or_billing_change',
    severity: 'critical',
    default_request_type: 'approval',
    default_timeout_class: 'fast',
    prompt_label: 'Credential rotation, billing-impacting action, or managed-cost override',
  },
];

const DEFAULT_APPROVAL_RULES: HitlApprovalRule[] = [
  {
    key: 'manual_hitl_request',
    request_type: 'approval',
    timeout_class: 'standard',
    approval_required: true,
  },
  {
    key: 'billing_cap_exceeded',
    request_type: 'approval',
    timeout_class: 'fast',
    approval_required: true,
  },
];

const DEFAULT_TIMEOUT_CLASSES: HitlTimeoutClass[] = [
  {
    key: 'fast',
    duration_minutes: 4 * 60,
    reminder_minutes_before: 60,
    escalation_mode: 'timeout_memo_and_escalate',
  },
  {
    key: 'standard',
    duration_minutes: 24 * 60,
    reminder_minutes_before: 60,
    escalation_mode: 'timeout_memo',
  },
  {
    key: 'extended',
    duration_minutes: 72 * 60,
    reminder_minutes_before: 4 * 60,
    escalation_mode: 'timeout_memo_and_escalate',
  },
];

function mergeByKey<T extends { key: string }>(defaults: T[], overrides: T[]) {
  const overrideMap = new Map(overrides.map((item) => [item.key, item]));
  return defaults.map((item) => overrideMap.get(item.key) ?? item);
}

function normalizeApprovalRule(rule: Pick<HitlApprovalRule, 'key' | 'timeout_class'>): HitlApprovalRule {
  return {
    key: rule.key,
    request_type: 'approval',
    timeout_class: rule.timeout_class,
    approval_required: true,
  };
}

export function getDefaultHitlPolicySnapshot(): HitlPolicySnapshot {
  const approvalRules = [...DEFAULT_APPROVAL_RULES];
  const timeoutClasses = [...DEFAULT_TIMEOUT_CLASSES];
  const highRiskActions = [...HIGH_RISK_ACTION_CATALOG];
  return {
    schema_version: 1,
    high_risk_actions: highRiskActions,
    approval_rules: approvalRules,
    timeout_classes: timeoutClasses,
    prompt_summary: buildHitlPolicyPromptSummary({
      high_risk_actions: highRiskActions,
      approval_rules: approvalRules,
      timeout_classes: timeoutClasses,
    }),
  };
}

export function parsePersistedHitlPolicyConfig(raw: unknown): PersistedHitlPolicyConfig {
  const parsed = persistedHitlPolicyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      schema_version: 1,
      approval_rules: [...DEFAULT_APPROVAL_RULES],
      timeout_classes: [...DEFAULT_TIMEOUT_CLASSES],
    };
  }

  return {
    schema_version: 1,
    approval_rules: mergeByKey(DEFAULT_APPROVAL_RULES, parsed.data.approval_rules.map((rule) => normalizeApprovalRule(rule))),
    timeout_classes: mergeByKey(DEFAULT_TIMEOUT_CLASSES, parsed.data.timeout_classes),
  };
}

export function buildHitlPolicySnapshot(raw: unknown): HitlPolicySnapshot {
  const config = parsePersistedHitlPolicyConfig(raw);
  const snapshot: HitlPolicySnapshot = {
    schema_version: 1,
    high_risk_actions: [...HIGH_RISK_ACTION_CATALOG],
    approval_rules: config.approval_rules,
    timeout_classes: config.timeout_classes,
    prompt_summary: '',
  };
  snapshot.prompt_summary = buildHitlPolicyPromptSummary(snapshot);
  return snapshot;
}

function getApprovalRuleLabel(key: HitlApprovalRuleKey) {
  switch (key) {
    case 'manual_hitl_request':
      return 'manual_hitl_request';
    case 'billing_cap_exceeded':
      return 'billing_cap_exceeded';
    default:
      return key;
  }
}

export function resolveHitlApprovalRule(
  snapshot: Pick<HitlPolicySnapshot, 'approval_rules'>,
  key: HitlApprovalRuleKey,
): HitlApprovalRule {
  return snapshot.approval_rules.find((rule) => rule.key === key)
    ?? DEFAULT_APPROVAL_RULES.find((rule) => rule.key === key)
    ?? DEFAULT_APPROVAL_RULES[0]!;
}

export function resolveHitlTimeoutClass(
  snapshot: Pick<HitlPolicySnapshot, 'timeout_classes'>,
  key: HitlTimeoutClassKey,
): HitlTimeoutClass {
  return snapshot.timeout_classes.find((timeoutClass) => timeoutClass.key === key)
    ?? DEFAULT_TIMEOUT_CLASSES.find((timeoutClass) => timeoutClass.key === key)
    ?? DEFAULT_TIMEOUT_CLASSES[0]!;
}

export function buildHitlPolicyPromptSummary(snapshot: Pick<HitlPolicySnapshot, 'high_risk_actions' | 'approval_rules' | 'timeout_classes'>) {
  const timeoutMap = new Map(snapshot.timeout_classes.map((timeoutClass) => [timeoutClass.key, timeoutClass]));
  const highRiskLines = snapshot.high_risk_actions
    .map((item) => `- ${item.prompt_label} -> ${item.default_request_type}/${item.default_timeout_class}`)
    .join('\n');
  const approvalLines = snapshot.approval_rules
    .map((rule) => {
      const timeoutClass = timeoutMap.get(rule.timeout_class);
      return `- ${getApprovalRuleLabel(rule.key)} -> ${rule.request_type}, timeout=${rule.timeout_class}${timeoutClass ? ` (${timeoutClass.duration_minutes}m, remind ${timeoutClass.reminder_minutes_before}m before, ${timeoutClass.escalation_mode})` : ''}`;
    })
    .join('\n');

  return [
    'HITL policy',
    'High-risk action catalog:',
    highRiskLines || '- (none)',
    'Approval-needed events:',
    approvalLines || '- (none)',
  ].join('\n');
}

export class AgentHitlPolicyService {
  constructor(private readonly db: SupabaseClient) {}

  async getProjectPolicy(scope: { orgId: string; projectId: string }): Promise<HitlPolicySnapshot> {
    const { data, error } = await this.db
      .from('agent_hitl_policies')
      .select('config')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .maybeSingle();

    if (error) throw error;
    return buildHitlPolicySnapshot((data as { config?: unknown } | null)?.config ?? null);
  }

  async saveProjectPolicy(
    scope: { orgId: string; projectId: string; actorId: string },
    input: { approval_rules: HitlApprovalRule[]; timeout_classes: HitlTimeoutClass[] },
  ): Promise<HitlPolicySnapshot> {
    const parsed = saveHitlPolicyConfigSchema.safeParse({
      schema_version: 1,
      approval_rules: input.approval_rules,
      timeout_classes: input.timeout_classes,
    });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => issue.message).join(', '));
    }

    const normalized = {
      schema_version: 1 as const,
      approval_rules: mergeByKey(DEFAULT_APPROVAL_RULES, parsed.data.approval_rules.map((rule) => normalizeApprovalRule(rule))),
      timeout_classes: mergeByKey(DEFAULT_TIMEOUT_CLASSES, parsed.data.timeout_classes),
    };
    const now = new Date().toISOString();

    const { error } = await this.db
      .from('agent_hitl_policies')
      .upsert({
        org_id: scope.orgId,
        project_id: scope.projectId,
        config: normalized,
        created_by: scope.actorId,
        updated_by: scope.actorId,
        updated_at: now,
      }, { onConflict: 'project_id' });

    if (error) throw error;
    return buildHitlPolicySnapshot(normalized);
  }
}
