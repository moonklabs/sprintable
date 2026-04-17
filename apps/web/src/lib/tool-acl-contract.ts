import { BUILTIN_AGENT_TOOL_NAMES, type BuiltinAgentToolName } from '@/services/agent-builtin-tools';

export type ToolAclDeniedReasonCode =
  | 'project_not_allowlisted'
  | 'agent_scope_mismatch'
  | 'tool_not_allowlisted'
  | 'project_tool_not_registered';

export interface ToolAclRegistryInput {
  projectId: string;
  allowedProjectIds?: string[];
  agentId?: string;
  toolAllowlist?: string[];
}

export interface ToolAclRegistryBoundary {
  project_id: string;
  allowed_project_ids: string[];
  agent_id: string | null;
  project_in_scope: boolean;
  explicit_tool_names: string[];
}

export interface ToolAclDecision {
  allowed: boolean;
  reasonCode: ToolAclDeniedReasonCode | null;
  reason: string | null;
}

export interface ToolAclDeniedAudience {
  userReason: string;
  operatorReason: string;
  nextAction: string;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))];
}

export function isBuiltinAgentToolName(toolName: string): toolName is BuiltinAgentToolName {
  return (BUILTIN_AGENT_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function buildToolAclRegistryBoundary(input: ToolAclRegistryInput): ToolAclRegistryBoundary {
  const explicitToolNames = normalizeStringArray(input.toolAllowlist ?? [...BUILTIN_AGENT_TOOL_NAMES]);
  const allowedProjectIds = normalizeStringArray(input.allowedProjectIds ?? [input.projectId]);

  return {
    project_id: input.projectId,
    allowed_project_ids: allowedProjectIds,
    agent_id: input.agentId?.trim() ? input.agentId : null,
    project_in_scope: allowedProjectIds.includes(input.projectId),
    explicit_tool_names: explicitToolNames,
  };
}

export function getToolAclDeniedAudience(reasonCode: ToolAclDeniedReasonCode): ToolAclDeniedAudience {
  switch (reasonCode) {
    case 'project_not_allowlisted':
      return {
        userReason: 'This tool is unavailable because the current project is outside the deployment scope.',
        operatorReason: 'Deployment scope excludes the current project, so the runtime denied the tool before execution.',
        nextAction: 'Update the deployment project scope or run the request inside an allowed project.',
      };
    case 'agent_scope_mismatch':
      return {
        userReason: 'This tool is unavailable because the active registry does not belong to the current agent.',
        operatorReason: 'The effective tool registry was scoped to a different agent than the run owner.',
        nextAction: 'Check the deployment/persona binding and regenerate the registry for the correct agent.',
      };
    case 'tool_not_allowlisted':
      return {
        userReason: 'This tool is not available in the current persona allowlist.',
        operatorReason: 'The tool name is missing from the effective persona/deployment allowlist.',
        nextAction: 'Use an allowlisted tool or update the persona allowlist before retrying.',
      };
    case 'project_tool_not_registered':
      return {
        userReason: 'This tool is not approved for the current project.',
        operatorReason: 'No approved MCP server mapping exists for this tool in the current project.',
        nextAction: 'Approve the MCP connection or add the tool to the project-level allowed_tools mapping.',
      };
    default:
      return {
        userReason: 'This tool is unavailable in the current runtime boundary.',
        operatorReason: 'The runtime denied the tool because its effective ACL boundary did not permit execution.',
        nextAction: 'Review the effective deployment scope, persona allowlist, and project MCP mapping.',
      };
  }
}

export function evaluateToolAcl(input: {
  toolName: string;
  boundary: ToolAclRegistryBoundary;
  currentAgentId: string;
}): ToolAclDecision {
  if (!input.boundary.project_in_scope) {
    return {
      allowed: false,
      reasonCode: 'project_not_allowlisted',
      reason: 'current project is outside the deployment project scope',
    };
  }

  if (input.boundary.agent_id && input.boundary.agent_id !== input.currentAgentId) {
    return {
      allowed: false,
      reasonCode: 'agent_scope_mismatch',
      reason: 'tool registry agent scope does not match the current agent',
    };
  }

  if (!input.boundary.explicit_tool_names.includes(input.toolName)) {
    return {
      allowed: false,
      reasonCode: 'tool_not_allowlisted',
      reason: 'tool is not included in the effective allowlist',
    };
  }

  return {
    allowed: true,
    reasonCode: null,
    reason: null,
  };
}
