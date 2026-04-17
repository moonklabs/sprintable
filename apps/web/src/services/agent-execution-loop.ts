import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { AgentToolExecutionEngine, type ToolRegistry } from './agent-tool-execution-engine';
import { AgentRetryService, type RetryScheduler } from './agent-retry';
import { RoutingPolicyError } from './agent-routing-rule';
import { MemoService } from './memo';
import { fireWebhooks } from './webhook-notify';
import { AgentPersonaService } from './agent-persona';
import { AgentSessionLifecycleService, type AgentSessionRunRecord, type SessionResumeCandidate } from './agent-session-lifecycle';
import { ProjectContextLoader } from './project-context-loader';
import { buildAgentPromptMessages, type PromptMemoryRecord } from './agent-system-prompt';
import {
  AgentHitlPolicyService,
  getDefaultHitlPolicySnapshot,
  resolveHitlApprovalRule,
  resolveHitlTimeoutClass,
  type HitlApprovalRuleKey,
  type HitlPolicySnapshot,
} from './agent-hitl-policy';
import { calculateRunBilling, getManagedPricingRow, type RunBillingSummary } from './agent-run-billing';
import { BillingLimitEnforcer, createBlockedBillingPatch } from './billing-limit-enforcer';
import { notifySlackHitlRequest } from './slack-hitl';
import { createLLMClient, resolveLLMConfig } from '@/lib/llm';
import {
  createSessionMemoryWrite,
  createEmptyRetrievalDiagnostics,
  partitionLongTermMemoryRowsByScope,
  partitionSessionMemoryRowsByScope,
  type AgentMemoryProjectScope,
  type AgentSessionMemoryScope,
  type MemoryRetrievalDiagnostics,
} from '@/lib/agent-memory-contract';
import type { LLMClient, LLMConfig, LLMMessage } from '@/lib/llm';
import { parseManagedAgentDeploymentConfig, resolveManagedAgentAllowedProjectIds, type ManagedAgentDeploymentConfig } from '@/lib/managed-agent-contract';
type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

interface AgentRunRecord extends AgentSessionRunRecord {
  deployment_id?: string | null;
  per_run_cap_cents?: number | null;
}

interface MemoRecord {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown> | null;
}

interface MemoReplyRecord {
  id: string;
  memo_id: string;
  content: string;
  created_by: string;
  created_at: string;
}

interface TeamMemberRecord {
  id: string;
  org_id: string;
  project_id: string;
  type: string;
  name: string;
  role?: 'owner' | 'admin' | 'member';
  user_id?: string | null;
  is_active?: boolean;
}

interface AgentPersonaRecord {
  id: string;
  system_prompt: string;
  style_prompt: string | null;
  model: string | null;
  tool_allowlist?: string[];
}

interface AgentDeploymentRuntimeRecord {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  persona_id: string | null;
  model: string | null;
  status: string;
  config: ManagedAgentDeploymentConfig | null;
}

export interface AgentExecutionInput {
  runId: string;
  memoId: string;
  orgId: string;
  projectId: string;
  agentId: string;
  triggerEvent: 'memo.assigned' | 'agent_run.retry_requested' | 'agent_session.resumed';
  originalRunId?: string;
  routing?: {
    ruleId: string;
    autoReplyMode: 'process_and_forward' | 'process_and_report';
    forwardToAgentId?: string | null;
    originalAssignedTo?: string | null;
    targetRuntime?: string;
    targetModel?: string | null;
  };
}

export interface ToolCallRecord {
  iteration: number;
  toolName: string;
  toolSource: 'builtin' | 'external';
  durationMs: number;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface AgentExecutionResult {
  status: 'completed' | 'hitl' | 'failed' | 'held';
  replyId?: string;
  hitlRequestId?: string;
  llmCallCount: number;
  toolCallHistory: ToolCallRecord[];
  outputMemoIds: string[];
}

const MAX_LLM_CALLS = 20;
const PROMPT_MEMORY_LIMIT = 8;
const MEMORY_DIAGNOSTICS_SCAN_LIMIT = 24;

function normalizeErrorCode(raw: string): string {
  const prefix = raw.split(':', 1)[0]?.trim();
  const source = prefix || raw;
  return source
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'agent_execution_failed';
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function buildAuditSummary(eventType: string, payload: Record<string, unknown>): string {
  const toolName = asOptionalString(payload.tool_name);
  const toolSource = asOptionalString(payload.tool_source);
  const memoryKind = asOptionalString(payload.memory_kind);

  switch (eventType) {
    case 'agent_tool.executed':
      return `${toolSource ?? 'builtin'} tool ${toolName ?? 'unknown'} executed`;
    case 'agent_tool.failed':
      return `${toolSource ?? 'builtin'} tool ${toolName ?? 'unknown'} failed`;
    case 'agent_tool.external_executed':
      return `external tool ${toolName ?? 'unknown'} executed`;
    case 'agent_tool.external_failed':
      return `external tool ${toolName ?? 'unknown'} failed`;
    case 'agent_tool.acl_denied':
      return `tool ${toolName ?? 'unknown'} denied before execution`;
    case 'agent_tool.cross_scope_blocked':
      return `tool ${toolName ?? 'unknown'} blocked by project scope guard`;
    case 'agent_memory.cross_scope_blocked':
      return `${memoryKind ?? 'memory'} records blocked by project scope guard`;
    case 'agent_tool.ambiguous_external_mapping':
      return `tool ${toolName ?? 'unknown'} matched multiple external servers`;
    default:
      return asOptionalString(payload.summary) ?? eventType;
  }
}

const injectionSignals = [
  /ignore (all|any|previous|prior) instructions/i,
  /system prompt/i,
  /developer message/i,
  /tool call/i,
  /act as/i,
  /jailbreak/i,
  /bypass/i,
  /sudo/i,
  /<system>|<assistant>|<developer>/i,
];

const decisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('respond'),
    message: z.string().min(1),
    summary: z.string().max(240).optional(),
  }),
  z.object({
    action: z.literal('tool_call'),
    tool_name: z.string().min(1),
    tool_arguments: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('hitl'),
    title: z.string().min(1).max(120),
    question: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

type AgentDecision = z.infer<typeof decisionSchema>;

function coerceAgentDecision(raw: unknown): AgentDecision | null {
  const direct = decisionSchema.safeParse(raw);
  if (direct.success) return direct.data;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) return { action: 'respond', message: text };
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const toolArguments = obj.tool_arguments && typeof obj.tool_arguments === 'object'
    ? obj.tool_arguments as Record<string, unknown>
    : null;

  const message = typeof obj.message === 'string'
    ? obj.message
    : typeof obj.memo_content === 'string'
      ? obj.memo_content
      : typeof toolArguments?.reply_content === 'string'
        ? toolArguments.reply_content
        : typeof obj.response === 'string'
          ? obj.response
          : typeof obj.content === 'string'
            ? obj.content
            : typeof obj.text === 'string'
              ? obj.text
              : null;

  if (obj.action === 'reply_memo' && message) {
    return {
      action: 'respond',
      message,
      summary: typeof obj.reason === 'string' ? obj.reason : undefined,
    };
  }

  if (typeof obj.tool_name === 'string') {
    return {
      action: 'tool_call',
      tool_name: obj.tool_name,
      tool_arguments: (toolArguments ?? {}) as Record<string, unknown>,
      reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    };
  }

  if (
    typeof obj.title === 'string'
    && typeof obj.question === 'string'
    && typeof obj.reason === 'string'
  ) {
    return {
      action: 'hitl',
      title: obj.title,
      question: obj.question,
      reason: obj.reason,
    };
  }

  if (message) {
    return {
      action: 'respond',
      message,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    };
  }

  return null;
}

interface AgentExecutionLoopDependencies {
  resolveLLMConfigFn?: typeof resolveLLMConfig;
  createLLMClientFn?: (config: LLMConfig) => LLMClient;
  getManagedPricingRowFn?: typeof getManagedPricingRow;
  retryService?: RetryScheduler;
  fireWebhooksFn?: typeof fireWebhooks;
  memoService?: MemoService;
  projectContextLoader?: Pick<ProjectContextLoader, 'load'>;
  toolExecutionEngine?: Pick<AgentToolExecutionEngine, 'loadRegistry' | 'execute'>;
  billingLimitEnforcer?: Pick<BillingLimitEnforcer, 'enforceBeforeRun' | 'enforceAfterRun'>;
  sessionLifecycle?: Pick<AgentSessionLifecycleService, 'claimSession' | 'applyRunOutcome'>;
  hitlPolicyService?: Pick<AgentHitlPolicyService, 'getProjectPolicy'>;
}

export class AgentExecutionLoop {
  private readonly logger: Logger;
  private readonly resolveLLMConfigFn: typeof resolveLLMConfig;
  private readonly createLLMClientFn: (config: LLMConfig) => LLMClient;
  private readonly getManagedPricingRowFn: typeof getManagedPricingRow;
  private readonly retryService: RetryScheduler;
  private readonly fireWebhooksFn: typeof fireWebhooks;
  private readonly memoService: MemoService;
  private readonly projectContextLoader: Pick<ProjectContextLoader, 'load'>;
  private readonly toolExecutionEngine: Pick<AgentToolExecutionEngine, 'loadRegistry' | 'execute'>;
  private readonly billingLimitEnforcer: Pick<BillingLimitEnforcer, 'enforceBeforeRun' | 'enforceAfterRun'>;
  private readonly sessionLifecycle: Pick<AgentSessionLifecycleService, 'claimSession' | 'applyRunOutcome'>;
  private readonly hitlPolicyService: Pick<AgentHitlPolicyService, 'getProjectPolicy'>;

  constructor(
    private readonly supabase: SupabaseClient,
    deps: AgentExecutionLoopDependencies = {},
    logger: Logger = console,
  ) {
    this.logger = logger;
    this.resolveLLMConfigFn = deps.resolveLLMConfigFn ?? resolveLLMConfig;
    this.createLLMClientFn = deps.createLLMClientFn ?? createLLMClient;
    this.getManagedPricingRowFn = deps.getManagedPricingRowFn ?? getManagedPricingRow;
    this.retryService = deps.retryService ?? new AgentRetryService(supabase);
    this.fireWebhooksFn = deps.fireWebhooksFn ?? fireWebhooks;
    this.memoService = deps.memoService ?? new MemoService(supabase);
    this.projectContextLoader = deps.projectContextLoader ?? new ProjectContextLoader(supabase);
    this.toolExecutionEngine = deps.toolExecutionEngine ?? new AgentToolExecutionEngine(supabase, {
      auditLogger: (eventType, severity, payload) => this.logAudit(
        String(payload.org_id),
        String(payload.project_id),
        String(payload.agent_id),
        eventType,
        severity,
        payload,
      ),
    });
    this.billingLimitEnforcer = deps.billingLimitEnforcer ?? new BillingLimitEnforcer(supabase, {
      fireWebhooksFn: this.fireWebhooksFn,
    });
    this.sessionLifecycle = deps.sessionLifecycle ?? new AgentSessionLifecycleService(supabase);
    this.hitlPolicyService = deps.hitlPolicyService ?? new AgentHitlPolicyService(supabase);
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    const startedAt = Date.now();
    const toolCallHistory: ToolCallRecord[] = [];
    const outputMemoIds = new Set<string>();
    let llmCallCount = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const run = await this.getRun(input.runId);
    const memo = await this.getMemo(input.memoId);
    const agent = await this.getAgent(input.agentId);

    const memoAssigneeMismatch = memo.assigned_to !== input.agentId
      && input.routing?.originalAssignedTo !== memo.assigned_to;
    const scopeMismatch =
      run.org_id !== input.orgId ||
      run.project_id !== input.projectId ||
      run.agent_id !== input.agentId ||
      run.memo_id !== input.memoId ||
      memo.org_id !== input.orgId ||
      memo.project_id !== input.projectId ||
      memoAssigneeMismatch ||
      agent.org_id !== input.orgId ||
      agent.project_id !== input.projectId ||
      agent.type !== 'agent';

    if (scopeMismatch) {
      const errorCode =
        run.org_id !== input.orgId || memo.org_id !== input.orgId || agent.org_id !== input.orgId
          ? 'cross_org_blocked'
          : 'scope_mismatch';
      const eventType = errorCode === 'cross_org_blocked'
        ? 'agent_execution.cross_org_blocked'
        : 'agent_execution.cross_scope_blocked';

      await this.logAudit(run.org_id, run.project_id, run.agent_id, eventType, 'security', {
        input,
        error_code: errorCode,
        run_scope: { org_id: run.org_id, project_id: run.project_id, agent_id: run.agent_id, memo_id: run.memo_id },
        memo_scope: { org_id: memo.org_id, project_id: memo.project_id, assigned_to: memo.assigned_to },
      });
      await this.persistRunProgress(run.id, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        llm_call_count: llmCallCount,
        tool_call_history: toolCallHistory,
        output_memo_ids: [],
        last_error_code: errorCode,
        error_message: 'cross_org_or_cross_project_scope_blocked',
        result_summary: 'Execution blocked by scope integrity guard',
        failure_disposition: 'non_retryable',
        duration_ms_legacy: Date.now() - startedAt,
      });
      return { status: 'failed', llmCallCount, toolCallHistory, outputMemoIds: [] };
    }

    const billingGate = await this.billingLimitEnforcer.enforceBeforeRun({
      run,
      memo: { id: memo.id, title: memo.title },
    });
    if (billingGate.status === 'daily_cap_exceeded' || billingGate.status === 'monthly_cap_exceeded') {
      const blockedPatch = createBlockedBillingPatch(
        billingGate.status,
        billingGate.reason ?? 'billing_limit_exceeded',
      );
      await this.persistRunProgress(run.id, blockedPatch);
      await this.logAudit(run.org_id, run.project_id, run.agent_id, `agent_execution.${blockedPatch.last_error_code}`, 'warn', {
        run_id: run.id,
        memo_id: memo.id,
        reason: billingGate.reason,
      });
      return { status: 'failed', llmCallCount, toolCallHistory, outputMemoIds: [] };
    }

    let llmConfig: LLMConfig | null = null;
    let sessionId: string | null = run.session_id;

    try {
      const deployment = run.deployment_id
        ? await this.getDeploymentRuntime(input.orgId, input.projectId, input.agentId, run.deployment_id)
        : null;

      if (run.deployment_id && !deployment) {
        await this.markRunFailed(run.id, {
          llmCallCount,
          toolCallHistory,
          outputMemoIds: [],
          errorCode: 'deployment_contract_missing',
          errorMessage: `deployment_contract_missing:${run.deployment_id}`,
          resultSummary: 'Deployment-scoped run could not load its deployment contract',
          durationMs: Date.now() - startedAt,
          billing: await this.buildRunBillingSummary(run, null, totalInputTokens, totalOutputTokens),
          sessionId,
        }, run);
        return { status: 'failed', llmCallCount, toolCallHistory, outputMemoIds: [] };
      }

      if (run.deployment_id && deployment && !deployment.config) {
        await this.markRunFailed(run.id, {
          llmCallCount,
          toolCallHistory,
          outputMemoIds: [],
          errorCode: 'deployment_contract_invalid',
          errorMessage: `deployment_contract_invalid:${run.deployment_id}`,
          resultSummary: 'Deployment-scoped run could not parse its deployment contract',
          durationMs: Date.now() - startedAt,
          billing: await this.buildRunBillingSummary(run, null, totalInputTokens, totalOutputTokens),
          sessionId,
        }, run);
        return { status: 'failed', llmCallCount, toolCallHistory, outputMemoIds: [] };
      }

      const persona = deployment?.persona_id
        ? await this.getPersonaById(deployment.persona_id, input.orgId, input.projectId, input.agentId)
        : await this.getDefaultPersona(input.orgId, input.projectId, input.agentId);
      const deploymentConfig = deployment?.config ?? null;
      const allowedProjectIds = resolveManagedAgentAllowedProjectIds(deploymentConfig, input.projectId);
      const llmModel = deployment?.model ?? persona?.model ?? undefined;

      llmConfig = await this.resolveLLMConfigFn(input.projectId, deploymentConfig
        ? {
            provider: deploymentConfig.provider,
            billingMode: deploymentConfig.llm_mode,
            model: llmModel,
          }
        : llmModel
          ? { model: llmModel }
          : undefined);
      if (!llmConfig) {
        await this.markRunFailed(run.id, {
          llmCallCount,
          toolCallHistory,
          outputMemoIds: [],
          errorCode: 'llm_config_missing',
          errorMessage: 'llm_config_missing',
          resultSummary: 'No LLM configuration available for project',
          durationMs: Date.now() - startedAt,
          billing: await this.buildRunBillingSummary(run, null, totalInputTokens, totalOutputTokens),
          sessionId,
        }, run);
        return { status: 'failed', llmCallCount, toolCallHistory, outputMemoIds: [] };
      }

      const toolRegistry = await this.toolExecutionEngine.loadRegistry(input.projectId, persona?.tool_allowlist, {
        allowedProjectIds,
        agentId: input.agentId,
      });

      const sessionClaim = await this.sessionLifecycle.claimSession({
        run,
        memo,
        personaId: persona?.id ?? null,
        deploymentId: deployment?.id ?? run.deployment_id ?? null,
        channel: 'memo',
        resumeSuspended: input.triggerEvent !== 'memo.assigned',
      });
      sessionId = sessionClaim.session.id;
      await this.persistRunProgress(run.id, {
        session_id: sessionId,
        restored_memory_count: sessionClaim.restoredMemoryCount,
        llm_call_count: 0,
        tool_call_history: toolCallHistory,
        output_memo_ids: [],
        last_error_code: null,
        failure_disposition: null,
        model: String(llmConfig.model),
        llm_provider: llmConfig.billingMode,
        llm_provider_key: llmConfig.provider,
      });

      if (sessionClaim.holdRun) {
        await this.persistRunProgress(run.id, {
          status: 'held',
          result_summary: sessionClaim.holdReason === 'session_suspended'
            ? 'Queued while session is suspended'
            : 'Queued while session is waiting for capacity',
          error_message: null,
          last_error_code: null,
          failure_disposition: null,
          finished_at: null,
          session_id: sessionId,
        });
        return {
          status: 'held',
          llmCallCount,
          toolCallHistory,
          outputMemoIds: [],
        };
      }

      await this.persistRunProgress(run.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        finished_at: null,
        result_summary: 'Execution started',
        error_message: null,
        last_error_code: null,
        failure_disposition: null,
        session_id: sessionId,
      });

      const memoReplies = await this.getMemoReplies(memo.id);
      const promptInjectionDetected = this.detectPromptInjection([memo.content, ...memoReplies.map((reply) => reply.content)]);
      if (promptInjectionDetected) {
        await this.logAudit(run.org_id, run.project_id, run.agent_id, 'agent_execution.prompt_injection_signal', 'warn', {
          memo_id: memo.id,
          run_id: run.id,
        });
      }

      const sessionMemoryScope: AgentSessionMemoryScope = {
        orgId: input.orgId,
        projectId: input.projectId,
        agentId: input.agentId,
        sessionId,
      };
      const longTermMemoryScope: AgentMemoryProjectScope = {
        orgId: input.orgId,
        projectId: input.projectId,
        agentId: input.agentId,
      };

      const [projectContext, sessionResult, longTermResult, hitlPolicy] = await Promise.all([
        this.projectContextLoader.load({
          orgId: input.orgId,
          projectId: input.projectId,
          agentId: input.agentId,
        }),
        this.listSessionMemories(sessionMemoryScope),
        this.listLongTermMemories(longTermMemoryScope),
        this.loadHitlPolicySnapshot(input.orgId, input.projectId),
      ]);

      const sessionMemories = sessionResult.memories;
      const longTermMemories = longTermResult.memories;

      const memoryDiagnostics: MemoryRetrievalDiagnostics = {
        ...createEmptyRetrievalDiagnostics(),
        session: {
          queriedCount: sessionResult.queriedCount,
          inScopeCount: sessionMemories.length,
          blockedCount: sessionResult.blockedCount,
          injectedIds: sessionMemories.map((m) => m.id),
        },
        longTerm: {
          queriedCount: longTermResult.queriedCount,
          inScopeCount: longTermMemories.length,
          blockedCount: longTermResult.blockedCount,
          injectedIds: longTermMemories.map((m) => m.id),
        },
        totalInjected: sessionMemories.length + longTermMemories.length,
        droppedByTokenBudget: 0,
      };

      const llm = this.createLLMClientFn(llmConfig);
      const promptResult = buildAgentPromptMessages({
        memo,
        replies: memoReplies,
        agent,
        persona,
        project: projectContext.project,
        projectContextSummary: projectContext.summary,
        teamMembers: projectContext.teamMembers,
        sessionMemories,
        longTermMemories,
        allowedProjectIds,
        availableToolNames: toolRegistry.availableToolNames,
        hitlPolicySummary: hitlPolicy.prompt_summary,
        promptInjectionDetected,
      });
      const messages = promptResult.messages;
      memoryDiagnostics.droppedByTokenBudget = promptResult.memoriesDroppedByBudget;

      await this.persistRunProgress(run.id, { memory_diagnostics: memoryDiagnostics });

      for (let iteration = 1; iteration <= MAX_LLM_CALLS; iteration += 1) {
        llmCallCount = iteration;
        const decisionResult = await this.generateDecision(llm, messages);
        const decision = decisionResult.decision;
        totalInputTokens += decisionResult.usage.inputTokens;
        totalOutputTokens += decisionResult.usage.outputTokens;
        await this.persistRunProgress(run.id, {
          llm_call_count: llmCallCount,
          tool_call_history: toolCallHistory,
          output_memo_ids: Array.from(outputMemoIds),
          session_id: sessionId,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
        });

        if (decision.action === 'respond') {
          const responseResult = await this.finalizeMemoResponse(input, memo, agent, decision.message);
          outputMemoIds.add(responseResult.outputMemoId);
          await this.addSessionMemory({
            scope: sessionMemoryScope,
            runId: run.id,
            memoId: memo.id,
            memoryType: 'summary',
            content: decision.message,
          });
          const billing = await this.buildRunBillingSummary(run, llmConfig, totalInputTokens, totalOutputTokens);
          const resumptions = await this.completeRun(run, {
            llmCallCount,
            toolCallHistory,
            outputMemoIds: Array.from(outputMemoIds),
            resultSummary: decision.summary ?? responseResult.resultSummary,
            durationMs: Date.now() - startedAt,
            sessionId,
            billing,
          });
          await this.billingLimitEnforcer.enforceAfterRun({
            run,
            memo: { id: memo.id, title: memo.title },
          });
          const billingHitlRequestId = billing.capExceeded
            ? await this.createBillingCapHitlRequest(run, memo, sessionId, billing, hitlPolicy)
            : undefined;
          await this.resumeCandidateRuns(resumptions);
          return {
            status: 'completed',
            replyId: responseResult.replyId,
            hitlRequestId: billingHitlRequestId,
            llmCallCount,
            toolCallHistory,
            outputMemoIds: Array.from(outputMemoIds),
          };
        }

        if (decision.action === 'hitl') {
          const hitlRequest = await this.createHitlRequest(
            run,
            memo,
            agent.id,
            sessionId,
            decision.title,
            decision.question,
            decision.reason,
            hitlPolicy,
            'manual_hitl_request',
          );
          const hitlReply = await this.memoService.addReply(
            memo.id,
            `사람 확인이 필요해 HITL로 전환했습니다.\n\n사유: ${decision.reason}\n질문: ${decision.question}${hitlRequest.memoId ? `\n검토 메모: ${hitlRequest.memoId}` : ''}`,
            agent.id,
          );
          outputMemoIds.add(memo.id);
          if (hitlRequest.memoId) {
            outputMemoIds.add(hitlRequest.memoId);
          }
          await this.addSessionMemory({
            scope: sessionMemoryScope,
            runId: run.id,
            memoId: memo.id,
            memoryType: 'decision',
            content: `HITL requested: ${decision.reason}`,
          });
          const billing = await this.buildRunBillingSummary(run, llmConfig, totalInputTokens, totalOutputTokens);
          const resumptions = await this.completeRun(run, {
            status: 'hitl_pending',
            llmCallCount,
            toolCallHistory,
            outputMemoIds: Array.from(outputMemoIds),
            resultSummary: 'Execution handed off to HITL',
            durationMs: Date.now() - startedAt,
            sessionId,
            billing,
          });
          await this.billingLimitEnforcer.enforceAfterRun({
            run,
            memo: { id: memo.id, title: memo.title },
          });
          await this.resumeCandidateRuns(resumptions);
          return {
            status: 'hitl',
            replyId: hitlReply.id as string,
            hitlRequestId: hitlRequest.id,
            llmCallCount,
            toolCallHistory,
            outputMemoIds: Array.from(outputMemoIds),
          };
        }

        const toolExecution = await this.executeTool(decision.tool_name, decision.tool_arguments, {
          memo,
          agent,
          runId: run.id,
          sessionId,
        }, toolRegistry);
        const toolResult = toolExecution.payload;
        if (typeof toolResult.memo_id === 'string') {
          outputMemoIds.add(toolResult.memo_id);
        }
        toolCallHistory.push({
          iteration,
          toolName: decision.tool_name,
          toolSource: toolExecution.source,
          durationMs: toolExecution.durationMs,
          arguments: decision.tool_arguments,
          result: toolResult,
        });
        await this.persistRunProgress(run.id, {
          llm_call_count: llmCallCount,
          tool_call_history: toolCallHistory,
          output_memo_ids: Array.from(outputMemoIds),
          session_id: sessionId,
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
        });
        await this.addSessionMemory({
          scope: sessionMemoryScope,
          runId: run.id,
          memoId: memo.id,
          memoryType: 'context',
          content: `${decision.tool_name}: ${JSON.stringify(toolResult)}`,
        });

        messages.push({ role: 'assistant', content: JSON.stringify(decision) });
        messages.push({ role: 'user', content: `TOOL_RESULT ${decision.tool_name}: ${JSON.stringify(toolResult)}` });
      }

      const terminalBilling = await this.buildRunBillingSummary(run, llmConfig, totalInputTokens, totalOutputTokens);
      const resumptions = await this.markRunFailed(run.id, {
        llmCallCount: MAX_LLM_CALLS,
        toolCallHistory,
        outputMemoIds: Array.from(outputMemoIds),
        errorCode: 'llm_call_limit_exceeded',
        errorMessage: 'llm_call_limit_exceeded',
        resultSummary: 'LLM call limit exceeded, handed off for retry/HITL',
        durationMs: Date.now() - startedAt,
        billing: terminalBilling,
        sessionId,
      }, run);
      await this.billingLimitEnforcer.enforceAfterRun({
        run,
        memo: { id: memo.id, title: memo.title },
      });
      await this.resumeCandidateRuns(resumptions);
      return {
        status: 'failed',
        llmCallCount: MAX_LLM_CALLS,
        toolCallHistory,
        outputMemoIds: Array.from(outputMemoIds),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent_execution_failed';
      const persistFailure = message.startsWith('agent_run_persist_failed:');
      const terminalBilling = await this.buildRunBillingSummary(run, llmConfig ?? null, totalInputTokens, totalOutputTokens);
      const resumptions = await this.markRunFailed(run.id, {
        llmCallCount,
        toolCallHistory,
        outputMemoIds: Array.from(outputMemoIds),
        errorCode: normalizeErrorCode(message),
        errorMessage: message,
        resultSummary: persistFailure
          ? 'Execution failed because the run state could not be persisted'
          : 'Execution failed',
        durationMs: Date.now() - startedAt,
        billing: terminalBilling,
        sessionId,
      }, run);
      await this.billingLimitEnforcer.enforceAfterRun({
        run,
        memo: { id: memo.id, title: memo.title },
      });
      await this.resumeCandidateRuns(resumptions);
      return {
        status: 'failed',
        llmCallCount,
        toolCallHistory,
        outputMemoIds: Array.from(outputMemoIds),
      };
    }
  }

  private detectPromptInjection(contents: string[]): boolean {
    return contents.some((content) => injectionSignals.some((pattern) => pattern.test(content)));
  }

  private async generateDecision(
    llm: LLMClient,
    messages: LLMMessage[],
  ): Promise<{ decision: AgentDecision; usage: { inputTokens: number; outputTokens: number } }> {
    const response = await llm.generate(messages, { responseFormat: 'json_object' });

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text);
    } catch {
      parsedJson = response.text;
    }

    const decision = coerceAgentDecision(parsedJson);
    if (!decision) {
      const normalized = typeof parsedJson === 'string' ? parsedJson : JSON.stringify(parsedJson, null, 2);
      throw new Error(`invalid_agent_decision: ${normalized}`);
    }

    return {
      decision,
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
      },
    };
  }

  private async executeTool(
    toolName: ToolCallRecord['toolName'],
    args: Record<string, unknown>,
    ctx: { memo: MemoRecord; agent: TeamMemberRecord; runId: string; sessionId: string },
    registry: ToolRegistry,
  ) {
    return this.toolExecutionEngine.execute(toolName, args, ctx, registry);
  }

  private async finalizeMemoResponse(
    input: AgentExecutionInput,
    memo: MemoRecord,
    agent: TeamMemberRecord,
    message: string,
  ): Promise<{ replyId?: string; outputMemoId: string; resultSummary: string }> {
    if (input.routing?.autoReplyMode === 'process_and_forward') {
      const nextAgentId = input.routing.forwardToAgentId ?? null;
      if (!nextAgentId) {
        throw new RoutingPolicyError('routing_forward_target_required');
      }
      if (nextAgentId === agent.id) {
        throw new RoutingPolicyError('routing_self_forward_disallowed', { agentId: agent.id, ruleId: input.routing.ruleId });
      }
      await this.assertForwardTargetIsActiveAgent({
        memo,
        agentId: agent.id,
        nextAgentId,
        ruleId: input.routing.ruleId,
      });
      const forwarded = await this.memoService.create({
        project_id: memo.project_id,
        org_id: memo.org_id,
        title: memo.title ?? null,
        content: message,
        memo_type: memo.memo_type,
        assigned_to: nextAgentId,
        supersedes_id: memo.id,
        created_by: agent.id,
        metadata: {
          routing: {
            source_memo_id: memo.id,
            matched_rule_id: input.routing.ruleId,
            auto_reply_mode: input.routing.autoReplyMode,
          },
        },
      });
      return {
        outputMemoId: forwarded.id as string,
        resultSummary: 'Memo processed and forwarded',
      };
    }

    const reply = await this.memoService.addReply(memo.id, message, agent.id);
    if (input.routing?.autoReplyMode === 'process_and_report') {
      await this.memoService.resolve(memo.id, agent.id);
      return {
        replyId: reply.id as string,
        outputMemoId: memo.id,
        resultSummary: 'Memo processed and reported',
      };
    }

    return {
      replyId: reply.id as string,
      outputMemoId: memo.id,
      resultSummary: 'Memo reply created',
    };
  }

  private async assertForwardTargetIsActiveAgent(input: {
    memo: MemoRecord;
    agentId: string;
    nextAgentId: string;
    ruleId?: string;
  }) {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('id, type, is_active')
      .eq('id', input.nextAgentId)
      .eq('org_id', input.memo.org_id)
      .eq('project_id', input.memo.project_id)
      .single();

    if (error || !data || (data as { type: string }).type !== 'agent' || (data as { is_active: boolean | null }).is_active === false) {
      throw new RoutingPolicyError('routing_forward_target_must_be_active_agent', {
        agentId: input.agentId,
        ruleId: input.ruleId,
        targetAgentId: input.nextAgentId,
      });
    }
  }

  private async ensureSession(run: AgentRunRecord, memo: MemoRecord, agent: TeamMemberRecord, personaId: string | null): Promise<string> {
    const sessionKey = `memo:${memo.id}`;
    const { data: existing } = await this.supabase
      .from('agent_sessions')
      .select('id')
      .eq('org_id', run.org_id)
      .eq('project_id', run.project_id)
      .eq('agent_id', run.agent_id)
      .eq('session_key', sessionKey)
      .is('deleted_at', null)
      .maybeSingle();

    if (existing?.id) {
      await this.supabase
        .from('agent_sessions')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('id', existing.id);
      return existing.id as string;
    }

    const { data, error } = await this.supabase
      .from('agent_sessions')
      .insert({
        org_id: run.org_id,
        project_id: run.project_id,
        agent_id: run.agent_id,
        persona_id: personaId,
        session_key: sessionKey,
        channel: 'memo',
        title: memo.title ?? `Memo ${memo.id}`,
        metadata: { memo_id: memo.id, memo_type: memo.memo_type },
        created_by: memo.created_by,
        started_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id as string;
  }

  private async addSessionMemory(input: {
    scope: AgentSessionMemoryScope;
    runId: string;
    memoId: string;
    memoryType: 'context' | 'summary' | 'decision' | 'todo' | 'fact';
    content: string;
  }) {
    await this.supabase.from('agent_session_memories').insert(createSessionMemoryWrite({
      scope: input.scope,
      runId: input.runId,
      memoryType: input.memoryType,
      content: input.content,
      metadata: { memo_id: input.memoId },
    }));
  }

  private async loadHitlPolicySnapshot(orgId: string, projectId: string): Promise<HitlPolicySnapshot> {
    try {
      return await this.hitlPolicyService.getProjectPolicy({ orgId, projectId });
    } catch (error) {
      this.logger.warn(`[AgentExecutionLoop] Failed to load HITL policy, using defaults: ${error instanceof Error ? error.message : 'unknown_error'}`);
      return getDefaultHitlPolicySnapshot();
    }
  }

  private async createHitlRequest(
    run: AgentRunRecord,
    memo: MemoRecord,
    agentId: string,
    sessionId: string,
    title: string,
    question: string,
    reason: string,
    hitlPolicy: HitlPolicySnapshot,
    approvalRuleKey: HitlApprovalRuleKey,
  ): Promise<{ id: string; memoId: string | null }> {
    const requestedFor = await this.getHitlRecipient(memo);
    const approvalRule = resolveHitlApprovalRule(hitlPolicy, approvalRuleKey);
    const timeoutClass = resolveHitlTimeoutClass(hitlPolicy, approvalRule.timeout_class);
    const expiresAt = new Date(Date.now() + (timeoutClass.duration_minutes * 60 * 1000)).toISOString();
    const hitlPrompt = `${reason}\n\n${question}`;
    const hitlMetadata = {
      memo_id: memo.id,
      source_memo_id: memo.id,
      source_memo_title: memo.title,
      source_memo_created_by: memo.created_by,
      approval_rule: approvalRule.key,
      timeout_class: timeoutClass.key,
      reminder_minutes_before: timeoutClass.reminder_minutes_before,
      escalation_mode: timeoutClass.escalation_mode,
    };
    let hitlRequestId: string | null = null;
    let hitlMemoId: string | null = null;

    try {
      const { data, error } = await this.supabase
        .from('agent_hitl_requests')
        .insert({
          org_id: run.org_id,
          project_id: run.project_id,
          agent_id: run.agent_id,
          session_id: sessionId,
          run_id: run.id,
          request_type: approvalRule.request_type,
          title,
          prompt: hitlPrompt,
          requested_for: requestedFor,
          expires_at: expiresAt,
          metadata: hitlMetadata,
        })
        .select('id')
        .single();

      if (error) throw error;
      hitlRequestId = data.id as string;

      const hitlMemo = await this.memoService.create({
        org_id: run.org_id,
        project_id: run.project_id,
        title: `HITL 요청 · ${memo.title ?? title}`,
        content: [
          `원본 메모: ${memo.title ?? '(untitled memo)'}`,
          `원본 메모 ID: ${memo.id}`,
          `HITL 요청 ID: ${hitlRequestId}`,
          `요청 유형: ${approvalRule.request_type}`,
          `정책 규칙: ${approvalRule.key}`,
          `타임아웃 클래스: ${timeoutClass.key}`,
          `리마인더: 만료 ${timeoutClass.reminder_minutes_before}분 전`,
          `만료 후 처리: ${timeoutClass.escalation_mode}`,
          `사유: ${reason}`,
          `질문: ${question}`,
          `응답 기한: ${expiresAt}`,
        ].join('\n\n'),
        memo_type: 'task',
        assigned_to: requestedFor,
        created_by: agentId,
        metadata: {
          kind: 'hitl_request',
          source_memo_id: memo.id,
          hitl_request_id: hitlRequestId,
          run_id: run.id,
          expires_at: expiresAt,
          request_type: approvalRule.request_type,
          approval_rule: approvalRule.key,
          timeout_class: timeoutClass.key,
          escalation_mode: timeoutClass.escalation_mode,
        },
      });
      hitlMemoId = hitlMemo.id as string;

      const { error: hitlUpdateError } = await this.supabase
        .from('agent_hitl_requests')
        .update({
          metadata: {
            ...hitlMetadata,
            hitl_memo_id: hitlMemoId,
            hitl_memo_title: hitlMemo.title,
          },
        })
        .eq('id', hitlRequestId);

      if (hitlUpdateError) throw hitlUpdateError;

      await this.logAudit(run.org_id, run.project_id, agentId, 'agent_execution.hitl_requested', 'info', {
        run_id: run.id,
        memo_id: memo.id,
        hitl_request_id: hitlRequestId,
        hitl_memo_id: hitlMemoId,
        requested_for: requestedFor,
        request_type: approvalRule.request_type,
        approval_rule: approvalRule.key,
        timeout_class: timeoutClass.key,
      });

      await notifySlackHitlRequest(this.supabase, {
        request: {
          id: hitlRequestId,
          org_id: run.org_id,
          project_id: run.project_id,
          title,
          prompt: hitlPrompt,
          requested_for: requestedFor,
          status: 'pending',
          response_text: null,
          expires_at: expiresAt,
          metadata: {
            ...hitlMetadata,
            hitl_memo_id: hitlMemoId,
            hitl_memo_title: hitlMemo.title,
          },
        },
        sourceMemo: {
          id: memo.id,
          metadata: memo.metadata ?? null,
        },
        hitlMemoId,
        createdBy: agentId,
      }, {
        appUrl: process.env.NEXT_PUBLIC_APP_URL,
        logger: this.logger,
      });

      return { id: hitlRequestId, memoId: hitlMemoId };
    } catch (error) {
      await this.rollbackHitlArtifacts(hitlRequestId, hitlMemoId);
      throw error;
    }
  }

  private async rollbackHitlArtifacts(hitlRequestId: string | null, hitlMemoId: string | null) {
    const cleanupErrors: string[] = [];

    if (hitlRequestId) {
      const { error } = await this.supabase
        .from('agent_hitl_requests')
        .delete()
        .eq('id', hitlRequestId);
      if (error) cleanupErrors.push(`hitl_request:${error.message}`);
    }

    if (hitlMemoId) {
      const { error } = await this.supabase
        .from('memos')
        .delete()
        .eq('id', hitlMemoId);
      if (error) cleanupErrors.push(`hitl_memo:${error.message}`);
    }

    if (cleanupErrors.length > 0) {
      this.logger.error(`[AgentExecutionLoop] Failed to rollback HITL artifacts: ${cleanupErrors.join(', ')}`);
    }
  }

  private async createBillingCapHitlRequest(
    run: AgentRunRecord,
    memo: MemoRecord,
    sessionId: string,
    billing: RunBillingSummary,
    hitlPolicy: HitlPolicySnapshot,
  ): Promise<string> {
    const cap = billing.perRunCapCents ?? 0;
    const request = await this.createHitlRequest(
      run,
      memo,
      run.agent_id,
      sessionId,
      'Per-run cap exceeded',
      `이번 실행 비용이 cap(${cap} cents)을 넘었습니다. 결과를 검토하고 계속 진행할지 확인해주세요.`,
      `computed_cost_cents=${billing.computedCostCents}`,
      hitlPolicy,
      'billing_cap_exceeded',
    );
    return request.id;
  }

  private async buildRunBillingSummary(
    run: AgentRunRecord,
    llmConfig: LLMConfig | null,
    totalInputTokens: number,
    totalOutputTokens: number,
  ): Promise<RunBillingSummary> {
    if (!llmConfig) {
      return {
        llmProvider: null,
        llmProviderKey: null,
        model: null,
        computedCostCents: 0,
        costUsd: 0,
        inputTokens: null,
        outputTokens: null,
        billingNotes: ['llm_config_missing'],
        perRunCapCents: run.per_run_cap_cents ?? null,
        capExceeded: false,
      };
    }

    const normalizedInputTokens = totalInputTokens === 0 && totalOutputTokens === 0 ? null : totalInputTokens;
    const normalizedOutputTokens = totalInputTokens === 0 && totalOutputTokens === 0 ? null : totalOutputTokens;
    const pricingRow = llmConfig.billingMode === 'managed'
      ? await this.getManagedPricingRowFn(this.supabase, llmConfig.provider, String(llmConfig.model))
      : null;

    if (llmConfig.billingMode === 'managed' && !pricingRow) {
      this.logger.warn(
        `[AgentExecutionLoop] Missing managed pricing row for ${llmConfig.provider}/${String(llmConfig.model)}; using fallback input=$5/1M output=$15/1M`,
      );
    }

    return calculateRunBilling({
      llmConfig: {
        billingMode: llmConfig.billingMode,
        provider: llmConfig.provider,
        model: String(llmConfig.model),
        perRunCapCents: run.per_run_cap_cents ?? llmConfig.perRunCapCents ?? undefined,
      },
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      pricingRow,
    });
  }

  private async getHitlRecipient(memo: MemoRecord): Promise<string> {
    const { data: creator } = await this.supabase
      .from('team_members')
      .select('id, user_id, type, org_id, project_id, is_active')
      .eq('id', memo.created_by)
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .maybeSingle();

    if (creator?.id && creator.type === 'human' && creator.user_id && creator.is_active) {
      const { data: creatorOrgMember } = await this.supabase
        .from('org_members')
        .select('role')
        .eq('org_id', memo.org_id)
        .eq('user_id', creator.user_id)
        .in('role', ['owner', 'admin'])
        .maybeSingle();
      if (creatorOrgMember) return creator.id as string;
    }

    const adminRecipients = await this.listHitlAdminRecipients(memo.org_id, memo.project_id);
    if (adminRecipients.length > 0) return adminRecipients[0]!.id;

    throw new Error('No active admin team member available for HITL');
  }

  private async listHitlAdminRecipients(orgId: string, projectId: string): Promise<TeamMemberRecord[]> {
    const { data: orgMembers, error: orgMembersError } = await this.supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .in('role', ['owner', 'admin']);

    if (orgMembersError) throw orgMembersError;

    const adminUserIds = (orgMembers ?? [])
      .map((row) => (row as { user_id?: string | null }).user_id ?? null)
      .filter((userId): userId is string => Boolean(userId));

    if (adminUserIds.length === 0) return [];

    const { data: teamMembers, error: teamMembersError } = await this.supabase
      .from('team_members')
      .select('id, org_id, project_id, type, name, user_id, is_active')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('type', 'human')
      .eq('is_active', true)
      .in('user_id', adminUserIds);

    if (teamMembersError) throw teamMembersError;
    return (teamMembers ?? []) as TeamMemberRecord[];
  }

  private async completeRun(
    run: AgentRunRecord,
    input: {
      status?: 'completed' | 'hitl_pending';
      llmCallCount: number;
      toolCallHistory: ToolCallRecord[];
      outputMemoIds: string[];
      resultSummary: string;
      durationMs: number;
      sessionId: string;
      billing: RunBillingSummary;
    },
  ): Promise<SessionResumeCandidate[]> {
    await this.persistRunProgress(run.id, {
      status: input.status ?? 'completed',
      finished_at: new Date().toISOString(),
      llm_call_count: input.llmCallCount,
      tool_call_history: input.toolCallHistory,
      output_memo_ids: input.outputMemoIds,
      last_error_code: null,
      result_summary: input.resultSummary,
      duration_ms_legacy: input.durationMs,
      failure_disposition: null,
      session_id: input.sessionId,
      model: input.billing.model,
      input_tokens: input.billing.inputTokens,
      output_tokens: input.billing.outputTokens,
      cost_usd: input.billing.costUsd,
      computed_cost_cents: input.billing.computedCostCents,
      llm_provider: input.billing.llmProvider,
      llm_provider_key: input.billing.llmProviderKey,
      per_run_cap_cents: input.billing.perRunCapCents,
      billing_notes: input.billing.billingNotes,
    });

    const lifecycle = await this.sessionLifecycle.applyRunOutcome({
      run: { ...run, session_id: input.sessionId },
      sessionId: input.sessionId,
      outcome: input.status === 'hitl_pending' ? 'hitl_pending' : 'completed',
    });
    return lifecycle.resumptions;
  }

  private async markRunFailed(
    runId: string,
    input: {
      llmCallCount: number;
      toolCallHistory: ToolCallRecord[];
      outputMemoIds: string[];
      errorCode: string;
      errorMessage: string;
      resultSummary: string;
      durationMs: number;
      billing: RunBillingSummary;
      sessionId: string | null;
    },
    run: AgentRunRecord,
  ): Promise<SessionResumeCandidate[]> {
    await this.persistRunProgress(runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      llm_call_count: input.llmCallCount,
      tool_call_history: input.toolCallHistory,
      output_memo_ids: input.outputMemoIds,
      last_error_code: input.errorCode,
      error_message: input.errorMessage,
      result_summary: input.resultSummary,
      duration_ms_legacy: input.durationMs,
      failure_disposition: null,
      model: input.billing.model,
      input_tokens: input.billing.inputTokens,
      output_tokens: input.billing.outputTokens,
      cost_usd: input.billing.costUsd,
      computed_cost_cents: input.billing.computedCostCents,
      llm_provider: input.billing.llmProvider,
      llm_provider_key: input.billing.llmProviderKey,
      per_run_cap_cents: input.billing.perRunCapCents,
      billing_notes: input.billing.billingNotes,
    });

    await this.logAudit(run.org_id, run.project_id, run.agent_id, 'agent_execution.failed', 'error', {
      run_id: run.id,
      error_code: input.errorCode,
      error_message: input.errorMessage,
      tool_call_count: input.toolCallHistory.length,
      llm_call_count: input.llmCallCount,
    });

    const retry = await this.retryService.scheduleRetry(run.id);
    if (!retry.scheduled) {
      await this.fireWebhooksFn(this.supabase, run.org_id, {
        event: 'agent_run.final_failure',
        data: {
          run_id: run.id,
          agent_id: run.agent_id,
          retry_count: run.retry_count ?? 0,
          max_retries: run.max_retries ?? 0,
          error_code: input.errorCode,
          error_message: input.errorMessage,
        },
      });
    }

    if (!input.sessionId) {
      return [];
    }

    const lifecycle = await this.sessionLifecycle.applyRunOutcome({
      run: { ...run, session_id: input.sessionId, status: 'failed', last_error_code: input.errorCode, error_message: input.errorMessage, result_summary: input.resultSummary },
      sessionId: input.sessionId,
      outcome: 'failed',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryScheduled: retry.scheduled,
    });
    return lifecycle.resumptions;
  }

  private async resumeCandidateRuns(resumptions: SessionResumeCandidate[]) {
    for (const resumption of resumptions) {
      try {
        await this.execute({
          runId: resumption.runId,
          memoId: resumption.memoId,
          orgId: resumption.orgId,
          projectId: resumption.projectId,
          agentId: resumption.agentId,
          triggerEvent: 'agent_session.resumed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'session_resume_failed';
        await this.persistRunProgress(resumption.runId, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          last_error_code: 'session_resume_failed',
          error_message: message,
          result_summary: 'Queued run failed while resuming after session capacity was freed',
          failure_disposition: 'non_retryable',
        });
      }
    }
  }

  private async persistRunProgress(runId: string, patch: Record<string, unknown>) {
    const { error } = await this.supabase
      .from('agent_runs')
      .update(patch)
      .eq('id', runId);

    if (error) {
      this.logger.error('[AgentExecutionLoop] Failed to persist run progress:', error.message, { runId, patch });
      throw new Error(`agent_run_persist_failed:${error.message}`);
    }
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
        deployment_id: asOptionalString(payload.deployment_id),
        session_id: asOptionalString(payload.session_id),
        run_id: asOptionalString(payload.run_id),
        event_type: eventType,
        severity,
        summary: buildAuditSummary(eventType, payload),
        payload,
        created_by: asOptionalString(payload.created_by) ?? agentId,
      });

    if (error) {
      this.logger.error('[AgentExecutionLoop] Failed to log audit:', error.message);
    }
  }


  private async listSessionMemories(scope: AgentSessionMemoryScope): Promise<{ memories: PromptMemoryRecord[]; queriedCount: number; blockedCount: number }> {
    const [{ data: exactData, error: exactError }, { data: diagnosticData, error: diagnosticError }] = await Promise.all([
      this.supabase
        .from('agent_session_memories')
        .select('id, org_id, project_id, agent_id, session_id, memory_type, importance, content, created_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .eq('agent_id', scope.agentId)
        .eq('session_id', scope.sessionId)
        .is('deleted_at', null)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(PROMPT_MEMORY_LIMIT),
      this.supabase
        .from('agent_session_memories')
        .select('id, org_id, project_id, agent_id, session_id, memory_type, importance, content, created_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(MEMORY_DIAGNOSTICS_SCAN_LIMIT),
    ]);
    if (exactError) throw exactError;
    if (diagnosticError) throw diagnosticError;

    const exactRows = (exactData ?? []) as Array<PromptMemoryRecord & {
      org_id: string;
      project_id: string;
      agent_id: string;
      session_id: string;
    }>;
    const diagnosticRows = (diagnosticData ?? []) as Array<PromptMemoryRecord & {
      org_id: string;
      project_id: string;
      agent_id: string;
      session_id: string;
    }>;
    const { outOfScope } = partitionSessionMemoryRowsByScope(diagnosticRows, scope);
    if (outOfScope.length > 0) {
      await this.logAudit(scope.orgId, scope.projectId, scope.agentId, 'agent_memory.cross_scope_blocked', 'security', {
        memory_kind: 'session_memory',
        session_id: scope.sessionId,
        blocked_count: outOfScope.length,
        expected_scope: {
          org_id: scope.orgId,
          project_id: scope.projectId,
          agent_id: scope.agentId,
          session_id: scope.sessionId,
        },
        blocked_memory_ids: outOfScope.map((row) => row.id),
      });
    }

    const memories = exactRows.map(({ id, memory_type, importance, content, created_at }) => ({
      id,
      memory_type,
      importance,
      content,
      created_at,
    }));

    return { memories, queriedCount: diagnosticRows.length, blockedCount: outOfScope.length };
  }

  private async listLongTermMemories(scope: AgentMemoryProjectScope): Promise<{ memories: PromptMemoryRecord[]; queriedCount: number; blockedCount: number }> {
    const [{ data: exactData, error: exactError }, { data: diagnosticData, error: diagnosticError }] = await Promise.all([
      this.supabase
        .from('agent_long_term_memories')
        .select('id, org_id, project_id, agent_id, memory_type, importance, content, created_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .eq('agent_id', scope.agentId)
        .is('deleted_at', null)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(PROMPT_MEMORY_LIMIT),
      this.supabase
        .from('agent_long_term_memories')
        .select('id, org_id, project_id, agent_id, memory_type, importance, content, created_at')
        .eq('org_id', scope.orgId)
        .eq('project_id', scope.projectId)
        .is('deleted_at', null)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(MEMORY_DIAGNOSTICS_SCAN_LIMIT),
    ]);
    if (exactError) throw exactError;
    if (diagnosticError) throw diagnosticError;

    const exactRows = (exactData ?? []) as Array<PromptMemoryRecord & {
      org_id: string;
      project_id: string;
      agent_id: string;
    }>;
    const diagnosticRows = (diagnosticData ?? []) as Array<PromptMemoryRecord & {
      org_id: string;
      project_id: string;
      agent_id: string;
    }>;
    const { outOfScope } = partitionLongTermMemoryRowsByScope(diagnosticRows, scope);
    if (outOfScope.length > 0) {
      await this.logAudit(scope.orgId, scope.projectId, scope.agentId, 'agent_memory.cross_scope_blocked', 'security', {
        memory_kind: 'long_term_memory',
        blocked_count: outOfScope.length,
        expected_scope: {
          org_id: scope.orgId,
          project_id: scope.projectId,
          agent_id: scope.agentId,
        },
        blocked_memory_ids: outOfScope.map((row) => row.id),
      });
    }

    const memories = exactRows.map(({ id, memory_type, importance, content, created_at }) => ({
      id,
      memory_type,
      importance,
      content,
      created_at,
    }));

    return { memories, queriedCount: diagnosticRows.length, blockedCount: outOfScope.length };
  }

  private async getRun(runId: string): Promise<AgentRunRecord> {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('id, org_id, project_id, agent_id, memo_id, deployment_id, session_id, status, per_run_cap_cents, retry_count, max_retries, started_at, finished_at, result_summary, last_error_code, error_message, next_retry_at, failure_disposition')
      .eq('id', runId)
      .single();
    if (error || !data) throw new Error(`agent_run_not_found:${runId}`);
    return data as AgentRunRecord;
  }

  private async getMemo(memoId: string): Promise<MemoRecord> {
    const { data, error } = await this.supabase
      .from('memos')
      .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, created_at, updated_at, metadata')
      .eq('id', memoId)
      .single();
    if (error || !data) throw new Error(`memo_not_found:${memoId}`);
    return data as MemoRecord;
  }

  private async getMemoReplies(memoId: string): Promise<MemoReplyRecord[]> {
    const { data, error } = await this.supabase
      .from('memo_replies')
      .select('id, memo_id, content, created_by, created_at')
      .eq('memo_id', memoId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MemoReplyRecord[];
  }

  private async getAgent(agentId: string): Promise<TeamMemberRecord> {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('id, org_id, project_id, type, name')
      .eq('id', agentId)
      .single();
    if (error || !data) throw new Error(`agent_not_found:${agentId}`);
    return data as TeamMemberRecord;
  }

  private async getDeploymentRuntime(
    orgId: string,
    projectId: string,
    agentId: string,
    deploymentId: string,
  ): Promise<AgentDeploymentRuntimeRecord | null> {
    const { data, error } = await this.supabase
      .from('agent_deployments')
      .select('id, org_id, project_id, agent_id, persona_id, model, status, config')
      .eq('id', deploymentId)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('agent_id', agentId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    return {
      ...(data as Omit<AgentDeploymentRuntimeRecord, 'config'> & { config: unknown }),
      config: parseManagedAgentDeploymentConfig((data as { config: unknown }).config),
    };
  }

  private async getPersonaById(personaId: string, orgId: string, projectId: string, agentId: string): Promise<AgentPersonaRecord | null> {
    const persona = await new AgentPersonaService(this.supabase).getPersonaById(personaId, {
      orgId,
      projectId,
      agentId,
    }).catch(() => null);

    if (!persona) return null;

    return {
      id: persona.id,
      system_prompt: persona.resolved_system_prompt,
      style_prompt: persona.resolved_style_prompt,
      model: persona.model,
      tool_allowlist: persona.tool_allowlist,
    };
  }

  private async getDefaultPersona(orgId: string, projectId: string, agentId: string): Promise<AgentPersonaRecord | null> {
    const persona = await new AgentPersonaService(this.supabase).getDefaultPersona({
      orgId,
      projectId,
      agentId,
    });

    if (!persona) return null;

    return {
      id: persona.id,
      system_prompt: persona.resolved_system_prompt,
      style_prompt: persona.resolved_style_prompt,
      model: persona.model,
      tool_allowlist: persona.tool_allowlist,
    };
  }
}
