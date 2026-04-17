import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { githubMcpToolArgumentSchemas, isGitHubMcpToolName } from '@/lib/github-mcp';
import { resolveMcpTokenRef } from '@/lib/mcp-secrets';
import {
  buildToolAclRegistryBoundary,
  evaluateToolAcl,
  getToolAclDeniedAudience,
  isBuiltinAgentToolName,
  type ToolAclDeniedReasonCode,
  type ToolAclRegistryBoundary,
} from '@/lib/tool-acl-contract';
import { AgentBuiltinToolService, BUILTIN_AGENT_TOOL_NAMES, type BuiltinAgentToolName } from './agent-builtin-tools';
import { listProjectApprovedMcpServerConfigs, parseMcpVaultRef, resolveProjectMcpVaultToken } from './project-mcp';

type AuditSeverity = 'debug' | 'info' | 'warn' | 'error' | 'security';

type AuditLogger = (eventType: string, severity: AuditSeverity, payload: Record<string, unknown>) => Promise<void>;

type FetchFn = typeof fetch;

interface MemoScope {
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
}

interface AgentScope {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
}

export interface ToolExecutionContext {
  memo: MemoScope;
  agent: AgentScope;
  runId: string;
  sessionId: string;
}

const EXTERNAL_TOOL_TIMEOUT_MS = 10_000;
const EXTERNAL_TOOL_SUMMARY_TOKEN_LIMIT = 4096;

type GenericExternalMcpServerConfig = {
  name: string;
  url: string;
  allowed_tools: string[];
  auth?: {
    token_ref: string;
    header_name?: string;
    scheme?: 'bearer' | 'plain';
  };
};
type GitHubExternalMcpServerConfig = {
  kind: 'github';
  name: 'github';
  url: string;
  allowed_tools: string[];
  auth: {
    token_ref: string;
    header_name?: string;
    scheme?: 'bearer' | 'plain';
  };
};
type ExternalServerConfig = (GenericExternalMcpServerConfig & { kind: 'generic' }) | GitHubExternalMcpServerConfig;

export interface ToolRegistry {
  builtinToolNames: string[];
  externalServers: ExternalServerConfig[];
  availableToolNames: string[];
  aclBoundary: ToolAclRegistryBoundary;
}

export interface ToolExecutionOutput {
  source: 'builtin' | 'external';
  durationMs: number;
  payload: Record<string, unknown>;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  return truncateText(text, maxTokens * 4);
}

function normalizeExternalSummary(result: unknown): string {
  if (result == null) return 'null';

  if (typeof result === 'string') {
    return truncateToTokenBudget(result, EXTERNAL_TOOL_SUMMARY_TOKEN_LIMIT);
  }

  if (typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    const textContent = (result as { content: unknown[] }).content
      .flatMap((entry) => {
        if (typeof entry === 'string') return [entry];
        if (!entry || typeof entry !== 'object') return [];
        const record = entry as Record<string, unknown>;
        if (typeof record.text === 'string') return [record.text];
        if (typeof record.content === 'string') return [record.content];
        return [JSON.stringify(entry)];
      })
      .join('\n');

    if (textContent.trim()) {
      return truncateToTokenBudget(textContent, EXTERNAL_TOOL_SUMMARY_TOKEN_LIMIT);
    }
  }

  return truncateToTokenBudget(JSON.stringify(result), EXTERNAL_TOOL_SUMMARY_TOKEN_LIMIT);
}

function mapGitHubMcpError(errorMessage: string, status?: number): string {
  const normalized = errorMessage.toLowerCase();
  if (status === 429 || normalized.includes('rate limit') || normalized.includes('secondary rate limit')) {
    return 'github_mcp_rate_limited';
  }
  if (status === 401 || status === 403 || normalized.includes('forbidden') || normalized.includes('resource not accessible')) {
    return 'github_mcp_permission_denied';
  }
  if ((status != null && status >= 500) || normalized.includes('bad gateway') || normalized.includes('gateway') || normalized.includes('econnrefused')) {
    return 'github_mcp_gateway_unavailable';
  }
  return errorMessage;
}

export class AgentToolExecutionEngine {
  private readonly builtinToolService: AgentBuiltinToolService;
  private readonly fetchFn: FetchFn;
  private readonly auditLogger?: AuditLogger;

  constructor(
    supabase: SupabaseClient,
    options: {
      builtinToolService?: AgentBuiltinToolService;
      fetchFn?: FetchFn;
      auditLogger?: AuditLogger;
    } = {},
  ) {
    this.builtinToolService = options.builtinToolService ?? new AgentBuiltinToolService(supabase, {
      auditLogger: options.auditLogger,
    });
    this.fetchFn = options.fetchFn ?? fetch;
    this.auditLogger = options.auditLogger;
  }

  async loadRegistry(
    projectId: string,
    allowedToolNames?: string[],
    aclInput: {
      allowedProjectIds?: string[];
      agentId?: string;
    } = {},
  ): Promise<ToolRegistry> {
    const aclBoundary = buildToolAclRegistryBoundary({
      projectId,
      allowedProjectIds: aclInput.allowedProjectIds,
      agentId: aclInput.agentId,
      toolAllowlist: allowedToolNames,
    });
    const allowedToolSet = allowedToolNames ? new Set(allowedToolNames) : null;
    const builtin = aclBoundary.project_in_scope
      ? (allowedToolSet
        ? BUILTIN_AGENT_TOOL_NAMES.filter((name) => allowedToolSet.has(name))
        : [...BUILTIN_AGENT_TOOL_NAMES])
      : [];

    let approvedServers: ExternalServerConfig[] = [];
    try {
      approvedServers = await listProjectApprovedMcpServerConfigs(createSupabaseAdminClient() as never, projectId);
    } catch {
      approvedServers = [];
    }

    const externalServers = (aclBoundary.project_in_scope ? approvedServers : [])
      .map((server) => ({
        ...server,
        allowed_tools: allowedToolSet
          ? server.allowed_tools.filter((toolName) => allowedToolSet.has(toolName))
          : [...server.allowed_tools],
      }))
      .filter((server) => server.allowed_tools.length > 0);

    const externalToolNames = externalServers.flatMap((server) => server.allowed_tools);

    return {
      builtinToolNames: builtin,
      externalServers,
      availableToolNames: [...new Set([...builtin, ...externalToolNames])],
      aclBoundary,
    };
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
    registry: ToolRegistry,
  ): Promise<ToolExecutionOutput> {
    const aclDecision = evaluateToolAcl({
      toolName,
      boundary: registry.aclBoundary,
      currentAgentId: ctx.agent.id,
    });
    if (!aclDecision.allowed) {
      return this.denyToolExecution(
        isBuiltinAgentToolName(toolName) ? 'builtin' : 'external',
        toolName,
        ctx,
        registry,
        aclDecision.reasonCode ?? 'tool_not_allowlisted',
        aclDecision.reason ?? 'tool execution denied by ACL',
      );
    }

    if (registry.builtinToolNames.includes(toolName)) {
      const startedAt = Date.now();
      const payload = await this.builtinToolService.execute(toolName as BuiltinAgentToolName, args, ctx);
      const durationMs = Date.now() - startedAt;
      return {
        source: 'builtin',
        durationMs,
        payload: {
          source: 'builtin',
          duration_ms: durationMs,
          ...payload,
        },
      };
    }

    const matchingServers = registry.externalServers.filter((server) => server.allowed_tools.includes(toolName));
    if (matchingServers.length === 0) {
      return this.denyToolExecution(
        'external',
        toolName,
        ctx,
        registry,
        'project_tool_not_registered',
        'tool is not approved for this project or has no external server mapping',
      );
    }

    if (matchingServers.length > 1) {
      await this.auditLogger?.('agent_tool.ambiguous_external_mapping', 'security', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        tool_name: toolName,
        tool_source: 'external',
        outcome: 'failed',
        user_reason: 'This tool could not run because multiple external servers matched the same tool name.',
        operator_reason: 'The project-approved MCP mapping is ambiguous because more than one external server advertises this tool name.',
        next_action: 'Narrow the project-approved MCP mappings so the tool name resolves to exactly one external server.',
        server_names: matchingServers.map((server) => server.name),
      });
      return {
        source: 'external',
        durationMs: 0,
        payload: {
          source: 'external',
          duration_ms: 0,
          error: 'tool_name mapped to multiple external MCP servers',
          user_reason: 'This tool could not run because multiple external servers matched the same tool name.',
          next_action: 'Narrow the project-approved MCP mappings so the tool name resolves to exactly one external server.',
        },
      };
    }

    return this.callExternalServer(matchingServers[0], toolName, args, ctx);
  }

  private async denyToolExecution(
    source: ToolExecutionOutput['source'],
    toolName: string,
    ctx: ToolExecutionContext,
    registry: ToolRegistry,
    reasonCode: ToolAclDeniedReasonCode,
    reason: string,
  ): Promise<ToolExecutionOutput> {
    const audience = getToolAclDeniedAudience(reasonCode);

    await this.auditLogger?.('agent_tool.acl_denied', 'security', {
      org_id: ctx.memo.org_id,
      project_id: ctx.memo.project_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId,
      session_id: ctx.sessionId,
      tool_name: toolName,
      tool_source: source,
      outcome: 'denied',
      reason_code: reasonCode,
      reason,
      user_reason: audience.userReason,
      operator_reason: audience.operatorReason,
      next_action: audience.nextAction,
      acl_boundary: registry.aclBoundary,
    });

    return {
      source,
      durationMs: 0,
      payload: {
        source,
        duration_ms: 0,
        error: 'tool_acl_denied',
        reason_code: reasonCode,
        reason: audience.userReason,
        user_reason: audience.userReason,
        next_action: audience.nextAction,
      },
    };
  }

  private async callExternalServer(
    server: ExternalServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionOutput> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXTERNAL_TOOL_TIMEOUT_MS);

    try {
      const validatedArgs = server.kind === 'github' && isGitHubMcpToolName(toolName)
        ? githubMcpToolArgumentSchemas[toolName].parse(args)
        : args;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (server.auth?.token_ref) {
        const token = parseMcpVaultRef(server.auth.token_ref)
          ? await resolveProjectMcpVaultToken(createSupabaseAdminClient() as never, ctx.memo.project_id, server.auth.token_ref)
          : resolveMcpTokenRef(server.auth.token_ref);
        const headerName = server.auth.header_name ?? (server.kind === 'github' ? 'X-GitHub-Token' : 'Authorization');
        const scheme = server.auth.scheme ?? (server.kind === 'github' ? 'plain' : 'bearer');
        headers[headerName] = scheme === 'bearer' ? `Bearer ${token}` : token;
      }

      const response = await this.fetchFn(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${ctx.runId}:${toolName}:${Date.now()}`,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: validatedArgs,
          },
        }),
        signal: controller.signal,
      });

      const durationMs = Date.now() - startedAt;
      const json = await response.json().catch(() => ({})) as { error?: { message?: string }; result?: unknown };

      if (!response.ok) {
        const baseMessage = json.error?.message ?? `external_mcp_http_${response.status}`;
        throw new Error(server.kind === 'github' ? mapGitHubMcpError(baseMessage, response.status) : baseMessage);
      }

      if (json.error?.message) {
        throw new Error(server.kind === 'github' ? mapGitHubMcpError(json.error.message) : json.error.message);
      }

      const summary = normalizeExternalSummary(json.result);
      const payload = {
        source: 'external' as const,
        server_name: server.name,
        tool_name: toolName,
        duration_ms: durationMs,
        summary,
        summary_tokens: estimateTokens(summary),
      };

      await this.auditLogger?.('agent_tool.external_executed', 'info', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        server_name: server.name,
        server_kind: server.kind,
        tool_name: toolName,
        tool_source: 'external',
        outcome: 'allowed',
        duration_ms: durationMs,
        arguments: validatedArgs,
        summary,
      });

      return {
        source: 'external',
        durationMs,
        payload,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const rawMessage = error instanceof Error && error.name === 'AbortError'
        ? (server.kind === 'github' ? 'github_mcp_gateway_timeout' : 'external_mcp_timeout')
        : (error instanceof Error ? error.message : 'external_mcp_failed');
      const message = server.kind === 'github'
        ? mapGitHubMcpError(rawMessage)
        : rawMessage;

      await this.auditLogger?.('agent_tool.external_failed', 'warn', {
        org_id: ctx.memo.org_id,
        project_id: ctx.memo.project_id,
        agent_id: ctx.agent.id,
        run_id: ctx.runId,
        session_id: ctx.sessionId,
        server_name: server.name,
        server_kind: server.kind,
        tool_name: toolName,
        tool_source: 'external',
        outcome: 'failed',
        duration_ms: durationMs,
        error: message,
      });

      return {
        source: 'external',
        durationMs,
        payload: {
          source: 'external',
          server_name: server.name,
          tool_name: toolName,
          duration_ms: durationMs,
          error: message,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
