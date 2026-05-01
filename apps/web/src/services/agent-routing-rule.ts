
import { ForbiddenError, NotFoundError } from './sprint';

export type RoutingAutoReplyMode = 'process_and_forward' | 'process_and_report';
export type RoutingRuleMatchType = 'event' | 'channel' | 'project' | 'manual' | 'fallback';

export interface RoutingRuleConditions {
  memo_type: string[];
}

export interface RoutingRuleAction {
  auto_reply_mode: RoutingAutoReplyMode;
  forward_to_agent_id: string | null;
}

export interface RoutingRuleMetadata {
  auto_generated?: boolean;
  template_id?: string;
  generated_from_roles?: string[];
  rollout_saved_at?: string;
  rollback_snapshot?: RoutingRuleRollbackSnapshot;
  [key: string]: unknown;
}

export interface RoutingRuleSnapshotItem {
  agent_id: string;
  persona_id: string | null;
  deployment_id: string | null;
  name: string;
  priority: number;
  match_type: RoutingRuleMatchType;
  conditions: RoutingRuleConditions;
  action: RoutingRuleAction;
  target_runtime: string;
  target_model: string | null;
  is_enabled: boolean;
}

export interface RoutingRuleRollbackSnapshot {
  saved_at: string;
  item_count: number;
  items: RoutingRuleSnapshotItem[];
}

interface RoutingRuleRow {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  deployment_id: string | null;
  name: string;
  priority: number;
  match_type: RoutingRuleMatchType;
  conditions: unknown;
  action: unknown;
  target_runtime: string;
  target_model: string | null;
  is_enabled: boolean;
  metadata: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface RoutingScope {
  orgId: string;
  projectId: string;
}

interface RoutingAgentScope extends RoutingScope {
  agentId: string;
}

export interface RoutingRuleSummary {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  deployment_id: string | null;
  name: string;
  priority: number;
  match_type: RoutingRuleMatchType;
  conditions: RoutingRuleConditions;
  action: RoutingRuleAction;
  target_runtime: string;
  target_model: string | null;
  is_enabled: boolean;
  metadata: RoutingRuleMetadata;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRoutingRuleInput extends RoutingScope {
  actorId: string;
  agent_id: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name: string;
  priority?: number;
  match_type?: RoutingRuleMatchType;
  conditions?: unknown;
  action?: unknown;
  target_runtime?: string;
  target_model?: string | null;
  is_enabled?: boolean;
  metadata?: unknown;
}

export interface ReplaceRoutingRuleItemInput {
  id?: string;
  agent_id: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name: string;
  priority?: number;
  match_type?: RoutingRuleMatchType;
  conditions?: unknown;
  action?: unknown;
  target_runtime?: string;
  target_model?: string | null;
  is_enabled?: boolean;
  metadata?: unknown;
}

export interface ReplaceRoutingRulesInput extends RoutingScope {
  actorId: string;
  items: ReplaceRoutingRuleItemInput[];
}

export interface UpdateRoutingRuleInput {
  actorId: string;
  agent_id?: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name?: string;
  priority?: number;
  match_type?: RoutingRuleMatchType;
  conditions?: unknown;
  action?: unknown;
  target_runtime?: string;
  target_model?: string | null;
  is_enabled?: boolean;
  metadata?: unknown;
}

export interface RoutingPriorityUpdate {
  id: string;
  priority: number;
}

export interface RoutingEvaluationMemo {
  id: string;
  org_id: string;
  project_id: string;
  memo_type: string;
  assigned_to: string | null;
}

export interface RoutingEvaluationResult {
  matchedRule: RoutingRuleSummary | null;
  dispatchAgentId: string | null;
  originalAssignedTo: string | null;
  autoReplyMode: RoutingAutoReplyMode;
  forwardToAgentId: string | null;
}

export type RoutingPolicyErrorCode =
  | 'routing_forward_target_required'
  | 'routing_self_forward_disallowed'
  | 'routing_forward_target_must_be_active_agent';

export class RoutingPolicyError extends Error {
  constructor(
    public readonly code: RoutingPolicyErrorCode,
    public readonly details: { agentId?: string | null; ruleId?: string | null; targetAgentId?: string | null } = {},
  ) {
    super(
      code === 'routing_forward_target_required'
        ? 'process_and_forward requires forward_to_agent_id'
        : code === 'routing_self_forward_disallowed'
          ? 'forward_to_agent_id must differ from agent_id'
          : 'routing_forward_target_must_be_active_agent',
    );
    this.name = 'RoutingPolicyError';
  }
}

const DEFAULT_AUTO_REPLY_MODE: RoutingAutoReplyMode = 'process_and_report';
const DEFAULT_MATCH_TYPE: RoutingRuleMatchType = 'event';
const DEFAULT_TARGET_RUNTIME = 'openclaw';

export function getRoutingPolicyIssues(input: {
  agentId: string | null;
  action: RoutingRuleAction;
}): Array<{ code: RoutingPolicyErrorCode; message: string }> {
  const issues: Array<{ code: RoutingPolicyErrorCode; message: string }> = [];

  if (input.action.auto_reply_mode === 'process_and_forward' && !input.action.forward_to_agent_id) {
    issues.push({
      code: 'routing_forward_target_required',
      message: 'process_and_forward requires forward_to_agent_id',
    });
  }

  if (
    input.action.auto_reply_mode === 'process_and_forward'
    && input.agentId
    && input.action.forward_to_agent_id === input.agentId
  ) {
    issues.push({
      code: 'routing_self_forward_disallowed',
      message: 'forward_to_agent_id must differ from agent_id',
    });
  }

  return issues;
}

export function assertRoutingPolicy(input: {
  agentId: string | null;
  action: RoutingRuleAction;
  ruleId?: string | null;
}) {
  const issue = getRoutingPolicyIssues(input)[0];
  if (!issue) return;
  throw new RoutingPolicyError(issue.code, {
    agentId: input.agentId,
    ruleId: input.ruleId ?? null,
  });
}

function normalizeMemoTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((entry) => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean))];
}

export function normalizeRoutingMetadata(value: unknown): RoutingRuleMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...record,
    auto_generated: record.auto_generated === true,
    template_id: typeof record.template_id === 'string' && record.template_id.trim() ? record.template_id.trim() : undefined,
    generated_from_roles: Array.isArray(record.generated_from_roles)
      ? record.generated_from_roles.map((entry) => String(entry ?? '').trim()).filter(Boolean)
      : undefined,
    rollout_saved_at: typeof record.rollout_saved_at === 'string' && record.rollout_saved_at.trim()
      ? record.rollout_saved_at.trim()
      : undefined,
    rollback_snapshot: normalizeRoutingRollbackSnapshot(record.rollback_snapshot),
  };
}

export function createRoutingRuleSnapshotItem(rule: {
  agent_id: string;
  persona_id?: string | null;
  deployment_id?: string | null;
  name: string;
  priority?: number;
  match_type?: RoutingRuleMatchType;
  conditions?: unknown;
  action?: unknown;
  target_runtime?: string;
  target_model?: string | null;
  is_enabled?: boolean;
}): RoutingRuleSnapshotItem {
  return {
    agent_id: rule.agent_id,
    persona_id: rule.persona_id ?? null,
    deployment_id: rule.deployment_id ?? null,
    name: rule.name.trim(),
    priority: rule.priority ?? 100,
    match_type: rule.match_type ?? DEFAULT_MATCH_TYPE,
    conditions: normalizeRoutingConditions(rule.conditions),
    action: normalizeRoutingAction(rule.action),
    target_runtime: rule.target_runtime?.trim() || DEFAULT_TARGET_RUNTIME,
    target_model: rule.target_model?.trim() || null,
    is_enabled: rule.is_enabled ?? true,
  };
}

export function normalizeRoutingRollbackSnapshot(value: unknown): RoutingRuleRollbackSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    return undefined;
  }

  const items = record.items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => createRoutingRuleSnapshotItem({
      agent_id: String(item.agent_id ?? '').trim(),
      persona_id: typeof item.persona_id === 'string' ? item.persona_id : null,
      deployment_id: typeof item.deployment_id === 'string' ? item.deployment_id : null,
      name: String(item.name ?? '').trim() || 'Routing rule snapshot',
      priority: typeof item.priority === 'number' ? item.priority : undefined,
      match_type: typeof item.match_type === 'string' ? item.match_type as RoutingRuleMatchType : undefined,
      conditions: item.conditions,
      action: item.action,
      target_runtime: typeof item.target_runtime === 'string' ? item.target_runtime : undefined,
      target_model: typeof item.target_model === 'string' ? item.target_model : null,
      is_enabled: typeof item.is_enabled === 'boolean' ? item.is_enabled : undefined,
    }))
    .filter((item) => item.agent_id.length > 0 && item.name.length > 0);

  if (items.length === 0) {
    return undefined;
  }

  return {
    saved_at: typeof record.saved_at === 'string' && record.saved_at.trim()
      ? record.saved_at.trim()
      : new Date(0).toISOString(),
    item_count: typeof record.item_count === 'number' ? record.item_count : items.length,
    items,
  };
}

export function getRollbackSnapshotFromRules(rules: Array<{ metadata?: unknown }>): RoutingRuleRollbackSnapshot | undefined {
  for (const rule of rules) {
    const snapshot = normalizeRoutingMetadata(rule.metadata).rollback_snapshot;
    if (snapshot?.items.length) {
      return snapshot;
    }
  }
  return undefined;
}

export function buildDisabledRoutingRuleItems(rules: RoutingRuleSummary[]): ReplaceRoutingRuleItemInput[] {
  return rules.map((rule) => ({
    id: rule.id,
    agent_id: rule.agent_id,
    persona_id: rule.persona_id,
    deployment_id: rule.deployment_id,
    name: rule.name,
    priority: rule.priority,
    match_type: rule.match_type,
    conditions: rule.conditions,
    action: rule.action,
    target_runtime: rule.target_runtime,
    target_model: rule.target_model,
    is_enabled: false,
    metadata: rule.metadata,
  }));
}

export function normalizeRoutingConditions(value: unknown): RoutingRuleConditions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { memo_type: [] };
  }

  const record = value as Record<string, unknown>;
  return {
    memo_type: normalizeMemoTypes(record.memo_type),
  };
}

export function normalizeRoutingAction(value: unknown): RoutingRuleAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      auto_reply_mode: DEFAULT_AUTO_REPLY_MODE,
      forward_to_agent_id: null,
    };
  }

  const record = value as Record<string, unknown>;
  const autoReplyMode = record.auto_reply_mode === 'process_and_forward'
    ? 'process_and_forward'
    : DEFAULT_AUTO_REPLY_MODE;
  const forwardToAgentId = autoReplyMode === 'process_and_forward'
    && typeof record.forward_to_agent_id === 'string'
    && record.forward_to_agent_id.trim()
      ? record.forward_to_agent_id.trim()
      : null;

  return {
    auto_reply_mode: autoReplyMode,
    forward_to_agent_id: forwardToAgentId,
  };
}

function presentRule(row: RoutingRuleRow): RoutingRuleSummary {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    persona_id: row.persona_id,
    deployment_id: row.deployment_id,
    name: row.name,
    priority: row.priority,
    match_type: row.match_type,
    conditions: normalizeRoutingConditions(row.conditions),
    action: normalizeRoutingAction(row.action),
    target_runtime: row.target_runtime,
    target_model: row.target_model,
    is_enabled: row.is_enabled,
    metadata: normalizeRoutingMetadata(row.metadata),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function matchesMemoType(conditions: RoutingRuleConditions, memoType: string): boolean {
  if (!conditions.memo_type.length) return true;
  return conditions.memo_type.includes(memoType.trim().toLowerCase());
}

export interface WorkflowVersionSummary {
  id: string;
  org_id: string;
  project_id: string;
  version: number;
  snapshot: RoutingRuleSnapshotItem[];
  change_summary: {
    added_rules: number;
    removed_rules: number;
    changed_rules: number;
  };
  created_by: string | null;
  created_at: string;
}

interface WorkflowVersionRow {
  id: string;
  org_id: string;
  project_id: string;
  version: number;
  snapshot: unknown;
  change_summary: unknown;
  created_by: string | null;
  created_at: string;
}

function presentVersion(row: WorkflowVersionRow): WorkflowVersionSummary {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    version: row.version,
    snapshot: (row.snapshot as RoutingRuleSnapshotItem[]) ?? [],
    change_summary: (row.change_summary as WorkflowVersionSummary['change_summary']) ?? { added_rules: 0, removed_rules: 0, changed_rules: 0 },
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export class AgentRoutingRuleService {
  constructor(private readonly db: any) {}

  async listRules(scope: RoutingScope): Promise<RoutingRuleSummary[]> {
    const { data, error } = await this.db
      .from('agent_routing_rules')
      .select('*')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .is('deleted_at', null)
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data ?? []).map((row) => presentRule(row as RoutingRuleRow));
  }

  async getRuleById(id: string, scope: RoutingScope): Promise<RoutingRuleSummary> {
    const row = await this.getRawRuleById(id, scope);
    return presentRule(row);
  }

  async createRule(input: CreateRoutingRuleInput): Promise<RoutingRuleSummary> {
    await this.assertAgentExists({ orgId: input.orgId, projectId: input.projectId, agentId: input.agent_id });
    if (input.persona_id) await this.assertPersonaExists(input.persona_id, { orgId: input.orgId, projectId: input.projectId, agentId: input.agent_id });
    if (input.deployment_id) await this.assertDeploymentExists(input.deployment_id, { orgId: input.orgId, projectId: input.projectId, agentId: input.agent_id });

    const action = normalizeRoutingAction(input.action);
    assertRoutingPolicy({ agentId: input.agent_id, action });
    if (action.forward_to_agent_id) {
      await this.assertAgentExists({ orgId: input.orgId, projectId: input.projectId, agentId: action.forward_to_agent_id });
    }

    const { data, error } = await this.db
      .from('agent_routing_rules')
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: input.agent_id,
        persona_id: input.persona_id ?? null,
        deployment_id: input.deployment_id ?? null,
        name: input.name.trim(),
        priority: input.priority ?? 100,
        match_type: input.match_type ?? DEFAULT_MATCH_TYPE,
        conditions: normalizeRoutingConditions(input.conditions),
        action,
        target_runtime: input.target_runtime?.trim() || DEFAULT_TARGET_RUNTIME,
        target_model: input.target_model?.trim() || null,
        is_enabled: input.is_enabled ?? true,
        metadata: normalizeRoutingMetadata(input.metadata),
        created_by: input.actorId,
      })
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('routing_rule_create_failed');
    return presentRule(data as RoutingRuleRow);
  }

  async updateRule(id: string, scope: RoutingScope, input: UpdateRoutingRuleInput): Promise<RoutingRuleSummary> {
    const current = await this.getRawRuleById(id, scope);

    const nextAgentId = input.agent_id ?? current.agent_id;
    await this.assertAgentExists({ orgId: current.org_id, projectId: current.project_id, agentId: nextAgentId });
    if (input.persona_id !== undefined && input.persona_id) {
      await this.assertPersonaExists(input.persona_id, { orgId: current.org_id, projectId: current.project_id, agentId: nextAgentId });
    }
    if (input.deployment_id !== undefined && input.deployment_id) {
      await this.assertDeploymentExists(input.deployment_id, { orgId: current.org_id, projectId: current.project_id, agentId: nextAgentId });
    }

    const nextAction = input.action === undefined
      ? normalizeRoutingAction(current.action)
      : normalizeRoutingAction(input.action);
    const currentMetadata = normalizeRoutingMetadata(current.metadata);
    const nextMetadata = input.metadata === undefined
      ? (currentMetadata.auto_generated === true
          ? { ...currentMetadata, auto_generated: false }
          : currentMetadata)
      : normalizeRoutingMetadata(input.metadata);
    assertRoutingPolicy({ agentId: nextAgentId, action: nextAction, ruleId: id });
    if (nextAction.forward_to_agent_id) {
      await this.assertAgentExists({ orgId: current.org_id, projectId: current.project_id, agentId: nextAction.forward_to_agent_id });
    }

    const patch = {
      agent_id: nextAgentId,
      persona_id: input.persona_id === undefined ? current.persona_id : input.persona_id,
      deployment_id: input.deployment_id === undefined ? current.deployment_id : input.deployment_id,
      name: input.name?.trim() || current.name,
      priority: input.priority ?? current.priority,
      match_type: input.match_type ?? current.match_type,
      conditions: input.conditions === undefined ? normalizeRoutingConditions(current.conditions) : normalizeRoutingConditions(input.conditions),
      action: nextAction,
      target_runtime: input.target_runtime?.trim() || (current.target_runtime || DEFAULT_TARGET_RUNTIME),
      target_model: input.target_model === undefined ? current.target_model : (input.target_model?.trim() || null),
      is_enabled: input.is_enabled ?? current.is_enabled,
      metadata: nextMetadata,
    };

    const { data, error } = await this.db
      .from('agent_routing_rules')
      .update(patch)
      .eq('id', id)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .is('deleted_at', null)
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('routing_rule_update_failed');
    return presentRule(data as RoutingRuleRow);
  }

  async replaceRules(input: ReplaceRoutingRulesInput): Promise<RoutingRuleSummary[]> {
    const scope = { orgId: input.orgId, projectId: input.projectId };
    const currentRules = await this.listRules(scope);
    const rolloutSavedAt = new Date().toISOString();
    const rollbackSnapshot = currentRules.length > 0
      ? {
          saved_at: rolloutSavedAt,
          item_count: currentRules.length,
          items: currentRules.map((rule) => createRoutingRuleSnapshotItem(rule)),
        }
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preparedItems: any[] = [];

    for (const [index, item] of input.items.entries()) {
      const existingRuleId = item.id?.trim() || undefined;
      const existingRule = existingRuleId ? await this.getRawRuleById(existingRuleId, scope) : null;

      await this.assertAgentExists({ orgId: input.orgId, projectId: input.projectId, agentId: item.agent_id });
      if (item.persona_id) {
        await this.assertPersonaExists(item.persona_id, { orgId: input.orgId, projectId: input.projectId, agentId: item.agent_id });
      }
      if (item.deployment_id) {
        await this.assertDeploymentExists(item.deployment_id, { orgId: input.orgId, projectId: input.projectId, agentId: item.agent_id });
      }

      const action = normalizeRoutingAction(item.action);
      const existingMetadata = existingRule ? normalizeRoutingMetadata(existingRule.metadata) : {};
      const metadata = item.metadata === undefined
        ? (existingMetadata.auto_generated === true
            ? { ...existingMetadata, auto_generated: false }
            : existingMetadata)
        : normalizeRoutingMetadata(item.metadata);
      const nextMetadata: RoutingRuleMetadata = {
        ...metadata,
        rollout_saved_at: rolloutSavedAt,
        rollback_snapshot: rollbackSnapshot,
      };
      assertRoutingPolicy({ agentId: item.agent_id, action, ruleId: existingRuleId ?? null });
      if (action.forward_to_agent_id) {
        await this.assertAgentExists({ orgId: input.orgId, projectId: input.projectId, agentId: action.forward_to_agent_id });
      }

      preparedItems.push({
        id: existingRuleId ?? null,
        agent_id: item.agent_id,
        persona_id: item.persona_id ?? null,
        deployment_id: item.deployment_id ?? null,
        name: item.name.trim(),
        priority: item.priority ?? (index + 1) * 10,
        match_type: item.match_type ?? DEFAULT_MATCH_TYPE,
        conditions: normalizeRoutingConditions(item.conditions),
        action,
        target_runtime: item.target_runtime?.trim() || DEFAULT_TARGET_RUNTIME,
        target_model: item.target_model?.trim() || null,
        is_enabled: item.is_enabled ?? true,
        metadata: nextMetadata,
      });
    }

    const { error } = await this.db.rpc('replace_agent_routing_rules', {
      _org_id: input.orgId,
      _project_id: input.projectId,
      _actor_id: input.actorId,
      _rules: preparedItems,
    });

    if (error) throw error;

    const newRules = await this.listRules(scope);
    await this.saveVersion({
      orgId: input.orgId,
      projectId: input.projectId,
      actorId: input.actorId,
      currentRules,
      newRules,
    });

    return newRules;
  }

  private async saveVersion(input: {
    orgId: string;
    projectId: string;
    actorId: string;
    currentRules: RoutingRuleSummary[];
    newRules: RoutingRuleSummary[];
  }): Promise<void> {
    const { data: versionData } = await this.db.rpc('next_workflow_version', {
      p_project_id: input.projectId,
    });

    const currentSet = new Map(input.currentRules.map((r) => [r.id, r]));
    const newSet = new Map(input.newRules.map((r) => [r.id, r]));
    const addedRules = input.newRules.filter((r) => !currentSet.has(r.id)).length;
    const removedRules = input.currentRules.filter((r) => !newSet.has(r.id)).length;
    const changedRules = input.newRules.filter((r) => {
      const prev = currentSet.get(r.id);
      return prev && JSON.stringify(createRoutingRuleSnapshotItem(prev)) !== JSON.stringify(createRoutingRuleSnapshotItem(r));
    }).length;

    const actorMember = await this.db
      .from('team_members')
      .select('id')
      .eq('id', input.actorId)
      .single();

    const createdBy = actorMember.data?.id ?? null;

    await this.db.from('workflow_versions').insert({
      org_id: input.orgId,
      project_id: input.projectId,
      version: versionData ?? 1,
      snapshot: input.newRules.map((r) => createRoutingRuleSnapshotItem(r)),
      change_summary: { added_rules: addedRules, removed_rules: removedRules, changed_rules: changedRules },
      created_by: createdBy,
    });
  }

  async listVersions(scope: RoutingScope): Promise<WorkflowVersionSummary[]> {
    const { data, error } = await this.db
      .from('workflow_versions')
      .select('*')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .order('version', { ascending: false });

    if (error) throw error;
    return (data ?? []).map((row) => presentVersion(row as WorkflowVersionRow));
  }

  async rollbackToVersion(
    versionId: string,
    scope: RoutingScope,
    actorId: string,
  ): Promise<RoutingRuleSummary[]> {
    const { data, error } = await this.db
      .from('workflow_versions')
      .select('*')
      .eq('id', versionId)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .single();

    if (error || !data) throw new NotFoundError('Workflow version not found');

    const version = presentVersion(data as WorkflowVersionRow);
    return this.replaceRules({
      orgId: scope.orgId,
      projectId: scope.projectId,
      actorId,
      items: version.snapshot.map((item) => ({
        agent_id: item.agent_id,
        persona_id: item.persona_id,
        deployment_id: item.deployment_id,
        name: item.name,
        priority: item.priority,
        match_type: item.match_type,
        conditions: item.conditions,
        action: item.action,
        target_runtime: item.target_runtime,
        target_model: item.target_model,
        is_enabled: item.is_enabled,
      })),
    });
  }

  async deleteRule(id: string, scope: RoutingScope): Promise<{ ok: true; id: string }> {
    await this.getRawRuleById(id, scope);

    const { error } = await this.db
      .from('agent_routing_rules')
      .update({ deleted_at: new Date().toISOString(), is_enabled: false })
      .eq('id', id)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .is('deleted_at', null);

    if (error) throw error;
    return { ok: true, id };
  }

  async disableRules(scope: RoutingScope): Promise<RoutingRuleSummary[]> {
    const { error } = await this.db
      .from('agent_routing_rules')
      .update({ is_enabled: false })
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .is('deleted_at', null);

    if (error) throw error;
    return this.listRules(scope);
  }

  async reorderPriorities(scope: RoutingScope, updates: RoutingPriorityUpdate[]): Promise<RoutingRuleSummary[]> {
    const cleaned = updates.map((item) => ({ id: item.id, priority: item.priority }));
    const { error } = await this.db.rpc('reorder_agent_routing_rules', {
      _org_id: scope.orgId,
      _project_id: scope.projectId,
      _updates: cleaned,
    });

    if (error) throw error;
    return this.listRules(scope);
  }

  async evaluateMemo(memo: RoutingEvaluationMemo): Promise<RoutingEvaluationResult> {
    if (!memo.assigned_to) {
      return {
        matchedRule: null,
        dispatchAgentId: null,
        originalAssignedTo: null,
        autoReplyMode: DEFAULT_AUTO_REPLY_MODE,
        forwardToAgentId: null,
      };
    }

    const rules = await this.listRules({ orgId: memo.org_id, projectId: memo.project_id });
    const matchedRule = rules.find((rule) => rule.is_enabled && matchesMemoType(rule.conditions, memo.memo_type));
    if (!matchedRule) {
      return {
        matchedRule: null,
        dispatchAgentId: memo.assigned_to,
        originalAssignedTo: memo.assigned_to,
        autoReplyMode: DEFAULT_AUTO_REPLY_MODE,
        forwardToAgentId: null,
      };
    }

    assertRoutingPolicy({
      agentId: matchedRule.agent_id,
      action: matchedRule.action,
      ruleId: matchedRule.id,
    });

    if (matchedRule.action.forward_to_agent_id) {
      try {
        await this.assertAgentExists({
          orgId: memo.org_id,
          projectId: memo.project_id,
          agentId: matchedRule.action.forward_to_agent_id,
        });
      } catch {
        throw new RoutingPolicyError('routing_forward_target_must_be_active_agent', {
          agentId: matchedRule.agent_id,
          ruleId: matchedRule.id,
          targetAgentId: matchedRule.action.forward_to_agent_id,
        });
      }
    }

    return {
      matchedRule,
      dispatchAgentId: matchedRule.agent_id,
      originalAssignedTo: memo.assigned_to,
      autoReplyMode: matchedRule.action.auto_reply_mode,
      forwardToAgentId: matchedRule.action.forward_to_agent_id,
    };
  }

  private async getRawRuleById(id: string, scope: RoutingScope): Promise<RoutingRuleRow> {
    const { data, error } = await this.db
      .from('agent_routing_rules')
      .select('*')
      .eq('id', id)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .is('deleted_at', null)
      .single();

    if (error || !data) {
      throw new NotFoundError('Routing rule not found');
    }

    return data as RoutingRuleRow;
  }

  private async assertAgentExists(scope: RoutingAgentScope) {
    const { data, error } = await this.db
      .from('team_members')
      .select('id, type, is_active')
      .eq('id', scope.agentId)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .single();

    if (error || !data) throw new NotFoundError('Routing target agent not found');
    if ((data as { type: string }).type !== 'agent') throw new ForbiddenError('Routing target must be an agent');
    if ((data as { is_active: boolean }).is_active === false) throw new ForbiddenError('Routing target agent is inactive');
  }

  private async assertPersonaExists(personaId: string, scope: RoutingAgentScope) {
    const { data, error } = await this.db
      .from('agent_personas')
      .select('id')
      .eq('id', personaId)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .is('deleted_at', null)
      .single();

    if (error || !data) throw new NotFoundError('Routing persona not found');
  }

  private async assertDeploymentExists(deploymentId: string, scope: RoutingAgentScope) {
    const { data, error } = await this.db
      .from('agent_deployments')
      .select('id')
      .eq('id', deploymentId)
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .is('deleted_at', null)
      .single();

    if (error || !data) throw new NotFoundError('Routing deployment not found');
  }
}
