// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { AgentExecutionLoop } from './agent-execution-loop';
import { AgentRoutingRuleService } from './agent-routing-rule';
import { buildAutomaticRoutingTemplate, resolveAutoRoutingPersonaRole, type AutoRoutingTemplateAgent, type AutoRoutingTemplateResult } from './agent-routing-template';
import { validateProjectMcpConnections } from './project-mcp';
import { fireWebhooks } from './webhook-notify';
import {
  buildManagedAgentDeploymentConfig,
  buildManagedAgentFailurePatch,
  clearManagedAgentFailurePatch,
  markManagedAgentDeploymentVerificationCompleted,
  normalizeManagedAgentDeploymentConfig,
  parseManagedAgentDeploymentConfig,
  type ManagedAgentDeploymentConfig,
  type ManagedAgentDeploymentFailure,
} from '@/lib/managed-agent-contract';

export type DeploymentLifecycleStatus = 'DEPLOYING' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED' | 'DEPLOY_FAILED';

type TransitionableStatus = Exclude<DeploymentLifecycleStatus, 'TERMINATED'>;

interface TeamMemberRecord {
  id: string;
  org_id: string;
  project_id: string;
  type: string;
  is_active: boolean;
  name: string;
}

interface AgentPersonaRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  slug: string;
  config: Record<string, unknown> | null;
  is_builtin: boolean;
  deleted_at: string | null;
}

interface ProjectLiveDeploymentRecord {
  id: string;
  agent_id: string;
  persona_id: string | null;
  status: DeploymentLifecycleStatus;
}

interface AgentDeploymentRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  name: string;
  runtime: string;
  model: string | null;
  version: string | null;
  status: DeploymentLifecycleStatus;
  config: ManagedAgentDeploymentConfig | null;
  last_deployed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_detail: Record<string, unknown> | null;
  failed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface QueuedRunRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  memo_id: string | null;
}

export interface CreateDeploymentInput {
  orgId: string;
  projectId: string;
  actorId: string;
  agentId: string;
  name: string;
  runtime?: string;
  model?: string | null;
  version?: string | null;
  personaId?: string | null;
  config?: ManagedAgentDeploymentConfig;
  overwriteRoutingRules?: boolean;
}

export interface TransitionDeploymentInput {
  orgId: string;
  projectId: string;
  actorId: string;
  deploymentId: string;
  status: Exclude<TransitionableStatus, 'DEPLOYING'>;
  failure?: ManagedAgentDeploymentFailure | null;
}

export interface TerminateDeploymentInput {
  orgId: string;
  projectId: string;
  actorId: string;
  deploymentId: string;
}

export interface DeploymentMutationResult {
  deployment: AgentDeploymentRecord;
  queueHeldCount: number;
  queueResumedCount: number;
  queueFailedCount: number;
}

export interface DeploymentPreflightResult {
  ok: boolean;
  checked_at: string;
  blocking_reasons: string[];
  warnings: string[];
  routing_template_id: AutoRoutingTemplateResult['templateId'];
  routing_rule_count: number;
  existing_routing_rule_count: number;
  requires_routing_overwrite_confirmation: boolean;
  mcp_validation_errors: string[];
}

const ACTIVE_DEPLOYMENT_STATUSES: DeploymentLifecycleStatus[] = ['DEPLOYING', 'ACTIVE', 'SUSPENDED'];
const TRANSITIONS: Record<DeploymentLifecycleStatus, DeploymentLifecycleStatus[]> = {
  DEPLOYING: ['ACTIVE', 'SUSPENDED', 'DEPLOY_FAILED', 'TERMINATED'],
  ACTIVE: ['SUSPENDED', 'DEPLOY_FAILED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'DEPLOY_FAILED', 'TERMINATED'],
  DEPLOY_FAILED: ['DEPLOYING', 'TERMINATED'],
  TERMINATED: [],
};

export class DeploymentLifecycleError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeploymentLifecycleError';
  }
}

function ensureTransitionAllowed(current: DeploymentLifecycleStatus, next: DeploymentLifecycleStatus) {
  if (!TRANSITIONS[current].includes(next)) {
    throw new DeploymentLifecycleError(
      'INVALID_DEPLOYMENT_TRANSITION',
      409,
      `Cannot transition deployment from ${current} to ${next}`,
    );
  }
}

export class AgentDeploymentLifecycleService {
  constructor(private readonly supabase: SupabaseClient) {}

  async runDeploymentPreflight(input: CreateDeploymentInput): Promise<DeploymentPreflightResult> {
    const checkedAt = new Date().toISOString();
    const blockingReasons = new Set<string>();
    const warnings: string[] = [];
    let deployablePersona: AgentPersonaRecord | null = null;
    let routingPreview: AutoRoutingTemplateResult = buildAutomaticRoutingTemplate({
      agents: [],
      existingRuleCount: 0,
    });

    try {
      const agent = await this.getAgent(input.orgId, input.projectId, input.agentId);
      if (!agent.is_active) {
        blockingReasons.add('Cannot deploy to an inactive agent');
      }

      if (input.personaId) {
        try {
          deployablePersona = await this.getDeployablePersona(input.orgId, input.projectId, input.agentId, input.personaId);
        } catch (error) {
          if (error instanceof DeploymentLifecycleError) {
            blockingReasons.add(error.message);
          } else {
            throw error;
          }
        }
      }

      routingPreview = await this.previewAutomaticRoutingTemplate({
        orgId: input.orgId,
        projectId: input.projectId,
        pendingAgent: {
          agentId: agent.id,
          agentName: agent.name,
          role: this.resolvePersonaRole(deployablePersona),
          personaId: deployablePersona?.id ?? null,
          deploymentId: null,
        },
      });

      if (routingPreview.rules.length > 0 && routingPreview.requiresOverwriteConfirmation && input.overwriteRoutingRules !== true) {
        blockingReasons.add('Existing routing rules require explicit overwrite confirmation before applying an automatic template');
      }

      try {
        await this.assertNoDuplicateLiveDeployment(input.orgId, input.projectId, input.agentId);
      } catch (error) {
        if (error instanceof DeploymentLifecycleError) {
          blockingReasons.add(error.message);
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof DeploymentLifecycleError) {
        blockingReasons.add(error.message);
      } else {
        throw error;
      }
    }

    const mcpValidation = await validateProjectMcpConnections(createSupabaseAdminClient() as never, {
      projectId: input.projectId,
    }).catch((error) => ({
      ok: false,
      errors: [error instanceof Error ? error.message : 'mcp_connection_validation_failed'],
    }));

    if (!mcpValidation.ok) {
      blockingReasons.add('Managed deployment validation failed for one or more MCP connections');
    }

    return {
      ok: blockingReasons.size === 0,
      checked_at: checkedAt,
      blocking_reasons: [...blockingReasons],
      warnings,
      routing_template_id: routingPreview.templateId,
      routing_rule_count: routingPreview.rules.length,
      existing_routing_rule_count: routingPreview.existingRuleCount,
      requires_routing_overwrite_confirmation: routingPreview.requiresOverwriteConfirmation,
      mcp_validation_errors: mcpValidation.errors,
    };
  }

  async createDeployment(input: CreateDeploymentInput): Promise<DeploymentMutationResult> {
    const preflight = await this.runDeploymentPreflight(input);
    if (!preflight.ok) {
      throw new DeploymentLifecycleError(
        'DEPLOYMENT_PREFLIGHT_FAILED',
        409,
        'Resolve preflight issues before deploying',
        { preflight },
      );
    }

    const agent = await this.getAgent(input.orgId, input.projectId, input.agentId);
    if (!agent.is_active) {
      throw new DeploymentLifecycleError('AGENT_INACTIVE', 409, 'Cannot deploy to an inactive agent');
    }

    const deployablePersona = input.personaId
      ? await this.getDeployablePersona(input.orgId, input.projectId, input.agentId, input.personaId)
      : null;

    const routingPreview = await this.previewAutomaticRoutingTemplate({
      orgId: input.orgId,
      projectId: input.projectId,
      pendingAgent: {
        agentId: agent.id,
        agentName: agent.name,
        role: this.resolvePersonaRole(deployablePersona),
        personaId: deployablePersona?.id ?? null,
        deploymentId: null,
      },
    });

    const deploymentConfig = input.config
      ? normalizeManagedAgentDeploymentConfig(input.config)
      : buildManagedAgentDeploymentConfig({
          llmMode: 'managed',
          provider: 'openai',
          scopeMode: 'projects',
          projectIds: [input.projectId],
        });

    const { data, error } = await this.supabase
      .from('agent_deployments')
      .insert({
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: input.agentId,
        persona_id: input.personaId ?? null,
        name: input.name,
        runtime: input.runtime ?? 'webhook',
        model: input.model ?? null,
        version: input.version ?? null,
        status: 'DEPLOYING',
        config: deploymentConfig,
        created_by: input.actorId,
        ...clearManagedAgentFailurePatch(),
      })
      .select('*')
      .single();

    if (error || !data) {
      if (error?.code === '23505') {
        throw new DeploymentLifecycleError(
          'DUPLICATE_AGENT_DEPLOYMENT',
          409,
          'A live deployment already exists for this agent in the current project',
        );
      }
      throw error ?? new Error('deployment_insert_failed');
    }

    const deployment = data as AgentDeploymentRecord;

    try {
      if (routingPreview.rules.length > 0) {
        const routingService = new AgentRoutingRuleService(this.supabase as never);
        const finalizedPreview = await this.previewAutomaticRoutingTemplate({
          orgId: input.orgId,
          projectId: input.projectId,
          pendingAgent: {
            agentId: agent.id,
            agentName: agent.name,
            role: this.resolvePersonaRole(deployablePersona),
            personaId: deployablePersona?.id ?? null,
            deploymentId: deployment.id,
          },
        });

        await routingService.replaceRules({
          orgId: input.orgId,
          projectId: input.projectId,
          actorId: input.actorId,
          items: finalizedPreview.rules,
        });
      }

      await this.logAudit(input.orgId, input.projectId, input.agentId, 'agent_deployment.initializing', 'info', {
        deployment_id: deployment.id,
        actor_id: input.actorId,
        runtime: deployment.runtime,
        model: deployment.model,
      });

      await fireWebhooks(this.supabase, input.orgId, {
        event: 'agent_deployment.initializing',
        data: {
          deployment_id: deployment.id,
          org_id: input.orgId,
          project_id: input.projectId,
          agent_id: input.agentId,
          actor_id: input.actorId,
          status: deployment.status,
          runtime: deployment.runtime,
          model: deployment.model,
          version: deployment.version,
        },
      });

      return await this.transitionDeployment({
        orgId: input.orgId,
        projectId: input.projectId,
        actorId: input.actorId,
        deploymentId: deployment.id,
        status: 'ACTIVE',
      });
    } catch (activationError) {
      const failureCode = activationError instanceof DeploymentLifecycleError
        ? activationError.code.toLowerCase()
        : 'deployment_activation_failed';
      const failureMessage = activationError instanceof DeploymentLifecycleError
        ? activationError.message
        : 'Managed deployment activation failed';
      const detailMessage = activationError instanceof Error ? activationError.message : 'deployment_activation_failed';

      return this.transitionDeployment({
        orgId: input.orgId,
        projectId: input.projectId,
        actorId: input.actorId,
        deploymentId: deployment.id,
        status: 'DEPLOY_FAILED',
        failure: {
          code: failureCode,
          message: failureMessage,
          detail: { error: detailMessage },
        },
      });
    }
  }

  async transitionDeployment(input: TransitionDeploymentInput): Promise<DeploymentMutationResult> {
    const deployment = await this.getDeployment(input.orgId, input.projectId, input.deploymentId);
    const previousStatus = deployment.status;
    ensureTransitionAllowed(previousStatus, input.status);

    if (ACTIVE_DEPLOYMENT_STATUSES.includes(input.status)) {
      await this.assertNoDuplicateLiveDeployment(input.orgId, input.projectId, deployment.agent_id, deployment.id);
    }

    let queueHeldCount = 0;
    let queueResumedCount = 0;
    let queueFailedCount = 0;
    const now = new Date().toISOString();

    if (input.status === 'SUSPENDED') {
      queueHeldCount = await this.updateQueueState(deployment.id, 'queued', 'held', {
        result_summary: 'Queued run held while deployment is suspended',
      });
    }

    if (input.status === 'ACTIVE' && previousStatus === 'SUSPENDED') {
      await this.updateQueueState(deployment.id, 'held', 'queued', {
        result_summary: 'Queued run resumed after deployment activation',
      });
    }

    if (input.status === 'DEPLOY_FAILED') {
      queueFailedCount = await this.failQueuedRuns(
        deployment.id,
        'deployment_failed',
        'Queued run cancelled because deployment failed',
      );
    }

    const patch: Record<string, unknown> = {
      status: input.status,
    };
    if (input.status === 'ACTIVE') {
      patch.last_deployed_at = now;
      Object.assign(patch, clearManagedAgentFailurePatch(now));
    }
    if (input.status === 'SUSPENDED') {
      Object.assign(patch, clearManagedAgentFailurePatch(now));
    }
    if (input.status === 'DEPLOY_FAILED') {
      Object.assign(
        patch,
        buildManagedAgentFailurePatch(input.failure ?? {
          code: 'deployment_failed',
          message: 'Deployment failed',
        }, now),
      );
    }

    const { data, error } = await this.supabase
      .from('agent_deployments')
      .update(patch)
      .eq('id', deployment.id)
      .select('*')
      .single();

    if (error || !data) {
      throw error ?? new Error('deployment_update_failed');
    }

    if (input.status === 'ACTIVE') {
      queueResumedCount = await this.resumeQueuedRuns(data as AgentDeploymentRecord);
    }

    const event = input.status === 'ACTIVE'
      ? (previousStatus === 'SUSPENDED' ? 'agent_deployment.resumed' : 'agent_deployment.activated')
      : input.status === 'SUSPENDED'
        ? 'agent_deployment.suspended'
        : 'agent_deployment.deploy_failed';

    await this.logAudit(input.orgId, input.projectId, deployment.agent_id, event, input.status === 'DEPLOY_FAILED' ? 'error' : 'info', {
      deployment_id: deployment.id,
      actor_id: input.actorId,
      from_status: previousStatus,
      to_status: input.status,
      queue_held_count: queueHeldCount,
      queue_resumed_count: queueResumedCount,
      queue_failed_count: queueFailedCount,
      failure_code: input.failure?.code ?? null,
      failure_message: input.failure?.message ?? null,
      failure_detail: input.failure?.detail ?? null,
    });

    await fireWebhooks(this.supabase, input.orgId, {
      event,
      data: {
        deployment_id: deployment.id,
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: deployment.agent_id,
        actor_id: input.actorId,
        from_status: previousStatus,
        status: input.status,
        queue_held_count: queueHeldCount,
        queue_resumed_count: queueResumedCount,
        queue_failed_count: queueFailedCount,
        failure_code: input.failure?.code ?? null,
        failure_message: input.failure?.message ?? null,
        failure_detail: input.failure?.detail ?? null,
      },
    });

    return {
      deployment: data as AgentDeploymentRecord,
      queueHeldCount,
      queueResumedCount,
      queueFailedCount,
    };
  }

  async completeDeploymentVerification(input: {
    orgId: string;
    projectId: string;
    actorId: string;
    deploymentId: string;
  }): Promise<{ deployment: AgentDeploymentRecord }> {
    const deployment = await this.getDeployment(input.orgId, input.projectId, input.deploymentId);
    if (deployment.status !== 'ACTIVE') {
      throw new DeploymentLifecycleError(
        'DEPLOYMENT_VERIFICATION_REQUIRES_ACTIVE_STATUS',
        409,
        'Deployment must be active before verification can be completed',
      );
    }

    const deploymentConfig = parseManagedAgentDeploymentConfig(deployment.config)
      ?? buildManagedAgentDeploymentConfig({
          llmMode: 'managed',
          provider: 'openai',
          scopeMode: 'projects',
          projectIds: [deployment.project_id],
        });
    const now = new Date().toISOString();
    const nextConfig = markManagedAgentDeploymentVerificationCompleted(deploymentConfig, input.actorId, now);

    const { data, error } = await this.supabase
      .from('agent_deployments')
      .update({
        config: nextConfig,
        updated_at: now,
      })
      .eq('id', deployment.id)
      .select('*')
      .single();

    if (error || !data) {
      throw error ?? new Error('deployment_verification_update_failed');
    }

    await this.logAudit(input.orgId, input.projectId, deployment.agent_id, 'agent_deployment.verification_completed', 'info', {
      deployment_id: deployment.id,
      actor_id: input.actorId,
      verification_status: nextConfig.verification?.status ?? 'completed',
      verification_completed_at: nextConfig.verification?.completed_at ?? now,
      verification_completed_by: nextConfig.verification?.completed_by ?? input.actorId,
      verification_required_checkpoints: nextConfig.verification?.required_checkpoints ?? [],
    });

    await fireWebhooks(this.supabase, input.orgId, {
      event: 'agent_deployment.verification_completed',
      data: {
        deployment_id: deployment.id,
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: deployment.agent_id,
        actor_id: input.actorId,
        verification_status: nextConfig.verification?.status ?? 'completed',
        verification_completed_at: nextConfig.verification?.completed_at ?? now,
        verification_completed_by: nextConfig.verification?.completed_by ?? input.actorId,
        verification_required_checkpoints: nextConfig.verification?.required_checkpoints ?? [],
      },
    });

    return {
      deployment: data as AgentDeploymentRecord,
    };
  }

  async terminateDeployment(input: TerminateDeploymentInput): Promise<DeploymentMutationResult> {
    const deployment = await this.getDeployment(input.orgId, input.projectId, input.deploymentId);
    const previousStatus = deployment.status;
    ensureTransitionAllowed(previousStatus, 'TERMINATED');

    const queueFailedCount = await this.failQueuedRuns(
      deployment.id,
      'deployment_terminated',
      'Queued run cancelled because deployment was terminated',
    );

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('agent_deployments')
      .update({
        status: 'TERMINATED',
        deleted_at: now,
      })
      .eq('id', deployment.id)
      .select('*')
      .single();

    if (error || !data) {
      throw error ?? new Error('deployment_terminate_failed');
    }

    await this.logAudit(input.orgId, input.projectId, deployment.agent_id, 'agent_deployment.terminated', 'warn', {
      deployment_id: deployment.id,
      actor_id: input.actorId,
      from_status: previousStatus,
      to_status: 'TERMINATED',
      queue_failed_count: queueFailedCount,
    });

    await fireWebhooks(this.supabase, input.orgId, {
      event: 'agent_deployment.terminated',
      data: {
        deployment_id: deployment.id,
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: deployment.agent_id,
        actor_id: input.actorId,
        from_status: previousStatus,
        status: 'TERMINATED',
        queue_failed_count: queueFailedCount,
      },
    });

    return {
      deployment: data as AgentDeploymentRecord,
      queueHeldCount: 0,
      queueResumedCount: 0,
      queueFailedCount,
    };
  }

  private getPersonaBasePersonaId(persona: AgentPersonaRecord | null): string | null {
    if (!persona?.config || typeof persona.config !== 'object' || Array.isArray(persona.config)) {
      return null;
    }

    const basePersonaId = (persona.config as Record<string, unknown>).base_persona_id;
    return typeof basePersonaId === 'string' && basePersonaId.trim() ? basePersonaId.trim() : null;
  }

  private resolvePersonaRole(
    persona: AgentPersonaRecord | null,
    basePersonaById: Map<string, AgentPersonaRecord> = new Map(),
  ) {
    const basePersonaId = this.getPersonaBasePersonaId(persona);
    const basePersonaSlug = basePersonaId ? basePersonaById.get(basePersonaId)?.slug ?? null : null;
    return resolveAutoRoutingPersonaRole({
      slug: persona?.slug ?? null,
      basePersonaSlug,
    });
  }

  private async listProjectLiveDeployments(orgId: string, projectId: string): Promise<ProjectLiveDeploymentRecord[]> {
    const { data, error } = await this.supabase
      .from('agent_deployments')
      .select('id, agent_id, persona_id, status')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .in('status', ACTIVE_DEPLOYMENT_STATUSES);

    if (error) throw error;
    return (data ?? []) as ProjectLiveDeploymentRecord[];
  }

  private async countProjectRoutingRules(orgId: string, projectId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('agent_routing_rules')
      .select('id')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .is('deleted_at', null);

    if (error) throw error;
    return (data ?? []).length;
  }

  private async listPersonasByIds(orgId: string, personaIds: string[]): Promise<AgentPersonaRecord[]> {
    if (!personaIds.length) return [];

    const { data, error } = await this.supabase
      .from('agent_personas')
      .select('id, org_id, project_id, agent_id, slug, config, is_builtin, deleted_at')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .in('id', personaIds);

    if (error) throw error;
    return (data ?? []) as AgentPersonaRecord[];
  }

  private async previewAutomaticRoutingTemplate(input: {
    orgId: string;
    projectId: string;
    pendingAgent: AutoRoutingTemplateAgent;
  }): Promise<AutoRoutingTemplateResult> {
    const [liveDeployments, existingRuleCount, agentRows] = await Promise.all([
      this.listProjectLiveDeployments(input.orgId, input.projectId),
      this.countProjectRoutingRules(input.orgId, input.projectId),
      this.supabase
        .from('team_members')
        .select('id, name')
        .eq('org_id', input.orgId)
        .eq('project_id', input.projectId)
        .eq('type', 'agent')
        .eq('is_active', true),
    ]);

    if (agentRows.error) throw agentRows.error;

    const personaIds = [...new Set([
      ...liveDeployments.map((deployment) => deployment.persona_id).filter((value): value is string => Boolean(value)),
      ...(input.pendingAgent.personaId ? [input.pendingAgent.personaId] : []),
    ])];
    const personas = await this.listPersonasByIds(input.orgId, personaIds);
    const basePersonaIds = [...new Set(personas
      .map((persona) => this.getPersonaBasePersonaId(persona))
      .filter((value): value is string => Boolean(value)))];
    const basePersonas = await this.listPersonasByIds(input.orgId, basePersonaIds);
    const personaById = new Map(personas.map((persona) => [persona.id, persona]));
    const basePersonaById = new Map(basePersonas.map((persona) => [persona.id, persona]));
    const agentNameById = new Map(((agentRows.data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));

    const agents: AutoRoutingTemplateAgent[] = liveDeployments.map((deployment) => ({
      agentId: deployment.agent_id,
      agentName: agentNameById.get(deployment.agent_id) ?? deployment.agent_id,
      role: this.resolvePersonaRole(deployment.persona_id ? personaById.get(deployment.persona_id) ?? null : null, basePersonaById),
      personaId: deployment.persona_id,
      deploymentId: deployment.id,
    }));
    agents.push(input.pendingAgent);

    return buildAutomaticRoutingTemplate({
      agents,
      existingRuleCount,
    });
  }

  private async getAgent(orgId: string, projectId: string, agentId: string): Promise<TeamMemberRecord> {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('id, org_id, project_id, type, is_active, name')
      .eq('id', agentId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .single();

    if (error || !data || data.type !== 'agent') {
      throw new DeploymentLifecycleError('AGENT_NOT_FOUND', 404, 'Agent not found in current project');
    }

    return data as TeamMemberRecord;
  }

  private async getDeployablePersona(orgId: string, projectId: string, agentId: string, personaId: string): Promise<AgentPersonaRecord> {
    const { data, error } = await this.supabase
      .from('agent_personas')
      .select('id, org_id, project_id, agent_id, slug, config, is_builtin, deleted_at')
      .eq('id', personaId)
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .maybeSingle();

    if (error || !data) {
      throw new DeploymentLifecycleError('PERSONA_NOT_FOUND', 404, 'Persona not found in the current organization');
    }

    if (data.is_builtin && (data.project_id !== projectId || data.agent_id !== agentId)) {
      throw new DeploymentLifecycleError('PERSONA_NOT_FOUND', 404, 'Persona not found for this agent in the current project');
    }

    return data as AgentPersonaRecord;
  }

  private async getDeployment(orgId: string, projectId: string, deploymentId: string): Promise<AgentDeploymentRecord> {
    const { data, error } = await this.supabase
      .from('agent_deployments')
      .select('*')
      .eq('id', deploymentId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .single();

    if (error || !data) {
      throw new DeploymentLifecycleError('DEPLOYMENT_NOT_FOUND', 404, 'Deployment not found in current project');
    }

    return data as AgentDeploymentRecord;
  }

  private async assertNoDuplicateLiveDeployment(orgId: string, projectId: string, agentId: string, currentDeploymentId?: string) {
    const query = this.supabase
      .from('agent_deployments')
      .select('id, status')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('agent_id', agentId)
      .is('deleted_at', null)
      .in('status', ACTIVE_DEPLOYMENT_STATUSES);

    const { data, error } = currentDeploymentId
      ? await query.neq('id', currentDeploymentId)
      : await query;

    if (error) throw error;
    if ((data ?? []).length > 0) {
      throw new DeploymentLifecycleError(
        'DUPLICATE_AGENT_DEPLOYMENT',
        409,
        'A live deployment already exists for this agent in the current project',
      );
    }
  }

  private async updateQueueState(
    deploymentId: string,
    fromStatus: 'queued' | 'held',
    toStatus: 'queued' | 'held',
    patch: Record<string, unknown>,
  ): Promise<number> {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .update({ status: toStatus, ...patch })
      .eq('deployment_id', deploymentId)
      .eq('status', fromStatus)
      .select('id');

    if (error) throw error;
    return (data ?? []).length;
  }

  private async listQueuedRuns(deploymentId: string): Promise<QueuedRunRecord[]> {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, memo_id')
      .eq('deployment_id', deploymentId)
      .eq('status', 'queued')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data ?? []) as QueuedRunRecord[];
  }

  private async resumeQueuedRuns(deployment: AgentDeploymentRecord): Promise<number> {
    const queuedRuns = await this.listQueuedRuns(deployment.id);
    if (!queuedRuns.length) return 0;

    const executionLoop = new AgentExecutionLoop(this.supabase);
    let resumedCount = 0;

    for (const run of queuedRuns) {
      if (!run.memo_id) {
        await this.supabase
          .from('agent_runs')
          .update({
            status: 'failed',
            last_error_code: 'deployment_resume_missing_memo',
            error_message: 'Queued run is missing memo_id',
            finished_at: new Date().toISOString(),
          })
          .eq('id', run.id);
        await this.logAudit(run.org_id, run.project_id, run.agent_id, 'agent_deployment.resume_missing_memo', 'error', {
          deployment_id: deployment.id,
          run_id: run.id,
        });
        continue;
      }

      await this.supabase
        .from('agent_runs')
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          last_error_code: null,
          error_message: null,
          result_summary: 'Queued run resumed after deployment activation',
          finished_at: null,
        })
        .eq('id', run.id);

      resumedCount += 1;

      try {
        await executionLoop.execute({
          runId: run.id,
          memoId: run.memo_id,
          orgId: run.org_id,
          projectId: run.project_id,
          agentId: run.agent_id,
          triggerEvent: 'memo.assigned',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'deployment_resume_failed';
        await this.supabase
          .from('agent_runs')
          .update({
            status: 'failed',
            last_error_code: 'deployment_resume_failed',
            error_message: message,
            finished_at: new Date().toISOString(),
          })
          .eq('id', run.id);
        await this.logAudit(run.org_id, run.project_id, run.agent_id, 'agent_deployment.resume_execution_failed', 'error', {
          deployment_id: deployment.id,
          run_id: run.id,
          error_message: message,
        });
      }
    }

    return resumedCount;
  }

  private async failQueuedRuns(deploymentId: string, errorCode: string, errorMessage: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        last_error_code: errorCode,
        error_message: errorMessage,
        finished_at: new Date().toISOString(),
      })
      .eq('deployment_id', deploymentId)
      .in('status', ['queued', 'held'])
      .select('id');

    if (error) throw error;
    return (data ?? []).length;
  }

  private async logAudit(
    orgId: string,
    projectId: string,
    agentId: string,
    eventType: string,
    severity: 'debug' | 'info' | 'warn' | 'error' | 'security',
    payload: Record<string, unknown>,
  ) {
    const { error } = await this.supabase
      .from('agent_audit_logs')
      .insert({
        org_id: orgId,
        project_id: projectId,
        agent_id: agentId,
        event_type: eventType,
        severity,
        summary: eventType,
        payload,
      });

    if (error) throw error;
  }
}
