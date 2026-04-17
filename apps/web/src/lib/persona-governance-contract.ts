import type { PersonaToolOption } from '@/services/persona-composer';

export interface PersonaVersionMetadata {
  schema_version: 1;
  lineage_id: string;
  version_number: number;
  published_at: string | null;
  change_summary: string | null;
  rollback_target_version_number: number | null;
  rollback_source: 'agent_audit_logs';
}

export interface PersonaPermissionBoundary {
  schema_version: 1;
  mode: 'allowlist';
  allowed_tool_names: string[];
  builtin_tool_names: string[];
  external_tool_names: string[];
  mcp_server_names: string[];
  enforcement_layers: Array<'persona.tool_allowlist' | 'project.approved_mcp_tools' | 'runtime.tool_registry'>;
}

export interface PersonaChangeHistoryEntry {
  event_type: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'security';
  summary: string;
  created_at: string;
  created_by: string | null;
  version_number: number | null;
  change_summary: string | null;
  rollback_target_version_number: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0))];
}

function normalizeVersionNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function getPersonaVersionMetadata(
  rawConfig: unknown,
  fallback: { personaId: string; publishedAt: string; changeSummary?: string | null },
): PersonaVersionMetadata {
  const record = isRecord(rawConfig) ? rawConfig : {};
  const rawVersion = isRecord(record.version_metadata) ? record.version_metadata : {};

  return {
    schema_version: 1,
    lineage_id: typeof rawVersion.lineage_id === 'string' && rawVersion.lineage_id.trim()
      ? rawVersion.lineage_id
      : fallback.personaId,
    version_number: normalizeVersionNumber(rawVersion.version_number, 1),
    published_at: typeof rawVersion.published_at === 'string' && rawVersion.published_at.trim()
      ? rawVersion.published_at
      : fallback.publishedAt,
    change_summary: typeof rawVersion.change_summary === 'string'
      ? rawVersion.change_summary
      : fallback.changeSummary ?? null,
    rollback_target_version_number: typeof rawVersion.rollback_target_version_number === 'number'
      ? normalizeVersionNumber(rawVersion.rollback_target_version_number, rawVersion.rollback_target_version_number)
      : null,
    rollback_source: 'agent_audit_logs',
  };
}

export function buildInitialPersonaVersionMetadata(input: {
  personaId: string;
  publishedAt: string;
  changeSummary?: string | null;
}): PersonaVersionMetadata {
  return {
    schema_version: 1,
    lineage_id: input.personaId,
    version_number: 1,
    published_at: input.publishedAt,
    change_summary: input.changeSummary ?? 'Initial persona published',
    rollback_target_version_number: null,
    rollback_source: 'agent_audit_logs',
  };
}

export function bumpPersonaVersionMetadata(rawConfig: unknown, input: {
  personaId: string;
  publishedAt: string;
  changeSummary?: string | null;
}): PersonaVersionMetadata {
  const current = getPersonaVersionMetadata(rawConfig, {
    personaId: input.personaId,
    publishedAt: input.publishedAt,
  });

  return {
    schema_version: 1,
    lineage_id: current.lineage_id,
    version_number: current.version_number + 1,
    published_at: input.publishedAt,
    change_summary: input.changeSummary ?? 'Persona version published',
    rollback_target_version_number: current.version_number,
    rollback_source: 'agent_audit_logs',
  };
}

export function withPersonaVersionMetadata(config: Record<string, unknown>, versionMetadata: PersonaVersionMetadata) {
  return {
    ...config,
    version_metadata: versionMetadata,
  };
}

export function buildPersonaPermissionBoundary(toolAllowlist: string[], toolOptions: PersonaToolOption[]): PersonaPermissionBoundary {
  const optionMap = new Map(toolOptions.map((option) => [option.name, option]));
  const allowedToolNames = normalizeStringArray(toolAllowlist);
  const builtinToolNames = allowedToolNames.filter((toolName) => optionMap.get(toolName)?.source !== 'mcp');
  const externalOptions = allowedToolNames
    .map((toolName) => optionMap.get(toolName))
    .filter((option): option is PersonaToolOption => Boolean(option && option.source === 'mcp'));

  return {
    schema_version: 1,
    mode: 'allowlist',
    allowed_tool_names: allowedToolNames,
    builtin_tool_names: builtinToolNames,
    external_tool_names: [...new Set(externalOptions.map((option) => option.name))],
    mcp_server_names: [...new Set(externalOptions.map((option) => option.serverName).filter((name): name is string => Boolean(name)))],
    enforcement_layers: ['persona.tool_allowlist', 'project.approved_mcp_tools', 'runtime.tool_registry'],
  };
}

export function buildPersonaChangeHistoryEntry(row: {
  event_type: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'security';
  summary: string;
  created_at: string;
  created_by: string | null;
  payload: unknown;
}): PersonaChangeHistoryEntry {
  const payload = isRecord(row.payload) ? row.payload : {};
  const versionMetadata = isRecord(payload.version_metadata) ? payload.version_metadata : {};

  return {
    event_type: row.event_type,
    severity: row.severity,
    summary: row.summary,
    created_at: row.created_at,
    created_by: row.created_by,
    version_number: typeof versionMetadata.version_number === 'number'
      ? normalizeVersionNumber(versionMetadata.version_number, versionMetadata.version_number)
      : null,
    change_summary: typeof versionMetadata.change_summary === 'string'
      ? versionMetadata.change_summary
      : null,
    rollback_target_version_number: typeof versionMetadata.rollback_target_version_number === 'number'
      ? normalizeVersionNumber(versionMetadata.rollback_target_version_number, versionMetadata.rollback_target_version_number)
      : null,
  };
}
