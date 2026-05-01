import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildInitialPersonaVersionMetadata,
  buildPersonaChangeHistoryEntry,
  buildPersonaPermissionBoundary,
  bumpPersonaVersionMetadata,
  getPersonaVersionMetadata,
  type PersonaChangeHistoryEntry,
  type PersonaPermissionBoundary,
  type PersonaVersionMetadata,
  withPersonaVersionMetadata,
} from '@/lib/persona-governance-contract';
import { BUILTIN_AGENT_TOOL_NAMES } from './agent-builtin-tools';
import { listProjectPersonaAllowedToolNames, listProjectPersonaToolOptions } from './persona-composer';
import { ForbiddenError, NotFoundError } from './sprint';

export const PERSONA_ALLOWED_TOOLS = BUILTIN_AGENT_TOOL_NAMES;

export type PersonaAllowedTool = string;

export const MANAGED_SAFETY_LAYER_NOTICE = '## Safety Layer\n[Managed by runtime safety policy and injected separately at execution time.]';

interface PersonaConfig {
  base_persona_id?: string | null;
  tool_allowlist?: PersonaAllowedTool[];
  version_metadata?: PersonaVersionMetadata;
  [key: string]: unknown;
}

interface PersonaScope {
  orgId: string;
  projectId: string;
  agentId: string;
}

interface PersonaRow {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string;
  style_prompt: string | null;
  model: string | null;
  config: unknown;
  is_builtin: boolean;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AuditRow {
  event_type: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'security';
  summary: string;
  payload: unknown;
  created_by: string | null;
  created_at: string;
}

export interface PersonaSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  system_prompt: string;
  style_prompt: string | null;
  resolved_system_prompt: string;
  resolved_style_prompt: string | null;
  model: string | null;
  tool_allowlist: PersonaAllowedTool[];
  base_persona_id: string | null;
  base_persona: { id: string; name: string; slug: string; is_builtin: boolean } | null;
  is_builtin: boolean;
  is_default: boolean;
  is_in_use: boolean;
  version_metadata: PersonaVersionMetadata;
  permission_boundary: PersonaPermissionBoundary;
  change_history: PersonaChangeHistoryEntry[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListPersonasOptions extends PersonaScope {
  includeBuiltin?: boolean;
}

export interface CreatePersonaInput extends PersonaScope {
  actorId: string;
  name: string;
  slug?: string;
  description?: string | null;
  system_prompt?: string;
  style_prompt?: string | null;
  model?: string | null;
  base_persona_id?: string | null;
  tool_allowlist?: string[];
  is_default?: boolean;
}

export interface UpdatePersonaInput {
  actorId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  system_prompt?: string;
  style_prompt?: string | null;
  model?: string | null;
  base_persona_id?: string | null;
  tool_allowlist?: string[];
  is_default?: boolean;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'persona';
}

function normalizePersonaConfig(value: unknown): PersonaConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizeToolAllowlist(value: unknown, allowedTools: readonly string[]): PersonaAllowedTool[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is PersonaAllowedTool => typeof entry === 'string' && allowedTools.includes(entry));
}

function sanitizePromptValue(value: string | null | undefined, allowNull = false): string | null {
  if (value == null) return allowNull ? null : '';

  const normalized = value.trim();
  if (!normalized) return allowNull ? null : '';

  const safetyMatch = normalized.match(/(^|\n)#{1,6}\s*safety layer\b/i);
  if (!safetyMatch || safetyMatch.index == null) return normalized;

  const prefix = normalized.slice(0, safetyMatch.index).trim();
  return [prefix, MANAGED_SAFETY_LAYER_NOTICE].filter(Boolean).join('\n\n');
}

function validateToolAllowlist(value: string[] | undefined, allowedTools: readonly string[]): PersonaAllowedTool[] | undefined {
  if (value === undefined) return undefined;

  const unique = [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
  const invalid = unique.filter((entry) => !allowedTools.includes(entry));
  if (invalid.length > 0) {
    throw new Error(`Unsupported tool_allowlist entries: ${invalid.join(', ')}`);
  }

  return unique as PersonaAllowedTool[];
}

function isPayloadRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class AgentPersonaService {
  constructor(private readonly supabase: SupabaseClient) {}

  async listPersonas(options: ListPersonasOptions): Promise<PersonaSummary[]> {
    const { includeBuiltin = false } = options;
    const personas = await this.listRawPersonas(options);
    const filtered = includeBuiltin ? personas : personas.filter((persona) => !persona.is_builtin);
    return Promise.all(filtered.map((persona) => this.decoratePersona(persona)));
  }

  async getPersonaById(id: string, scope?: Partial<PersonaScope>): Promise<PersonaSummary> {
    const persona = await this.getRawPersonaById(id, scope);
    return this.decoratePersona(persona);
  }

  async getDefaultPersona(scope: PersonaScope): Promise<PersonaSummary | null> {
    const { data, error } = await this.supabase
      .from('agent_personas')
      .select('*')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .is('deleted_at', null)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;
    return this.decoratePersona(data as PersonaRow);
  }

  async createPersona(input: CreatePersonaInput): Promise<PersonaSummary> {
    await this.assertAgentExists(input);

    const allowedToolNames = await listProjectPersonaAllowedToolNames(this.supabase, input.projectId);
    const toolAllowlist = validateToolAllowlist(input.tool_allowlist, allowedToolNames);
    const basePersona = input.base_persona_id
      ? await this.getRawPersonaById(input.base_persona_id, input)
      : null;

    if (basePersona?.deleted_at) {
      throw new NotFoundError('Base persona not found');
    }

    if (input.is_default) {
      await this.clearDefaultPersona(input);
    }

    const createdAt = new Date().toISOString();
    const personaId = randomUUID();
    const versionMetadata = buildInitialPersonaVersionMetadata({
      personaId,
      publishedAt: createdAt,
    });

    const config = withPersonaVersionMetadata({
      base_persona_id: basePersona?.id ?? null,
      ...(toolAllowlist !== undefined ? { tool_allowlist: toolAllowlist } : {}),
    }, versionMetadata);

    const { data, error } = await this.supabase
      .from('agent_personas')
      .insert({
        id: personaId,
        org_id: input.orgId,
        project_id: input.projectId,
        agent_id: input.agentId,
        name: input.name.trim(),
        slug: slugify(input.slug ?? input.name),
        description: input.description?.trim() ?? null,
        system_prompt: sanitizePromptValue(input.system_prompt ?? '', false) ?? '',
        style_prompt: sanitizePromptValue(input.style_prompt, true),
        model: input.model?.trim() || null,
        config,
        is_default: input.is_default ?? false,
        created_by: input.actorId,
      })
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('persona_create_failed');

    const decorated = await this.decoratePersona(data as PersonaRow, new Set<string>(), { includeHistory: false });
    await this.logPersonaAudit(input.orgId, input.projectId, input.agentId, input.actorId, 'agent_persona.created', 'info', {
      persona: decorated,
      currentRow: data as PersonaRow,
      previousRow: null,
      summary: 'Initial persona version published',
    });

    return this.decoratePersona(data as PersonaRow);
  }

  async updatePersona(id: string, scope: Pick<PersonaScope, 'orgId' | 'projectId'>, input: UpdatePersonaInput): Promise<PersonaSummary> {
    const current = await this.getRawPersonaById(id, scope);
    if (current.is_builtin) {
      throw new ForbiddenError('Built-in personas cannot be modified');
    }

    const currentConfig = normalizePersonaConfig(current.config);
    const nextBasePersonaId = Object.prototype.hasOwnProperty.call(input, 'base_persona_id')
      ? input.base_persona_id ?? null
      : (typeof currentConfig.base_persona_id === 'string' ? currentConfig.base_persona_id : null);

    if (nextBasePersonaId === current.id) {
      throw new Error('Persona cannot inherit from itself');
    }

    const currentScope = {
      orgId: current.org_id,
      projectId: current.project_id,
      agentId: current.agent_id,
    } satisfies PersonaScope;

    const basePersona = nextBasePersonaId
      ? await this.getRawPersonaById(nextBasePersonaId, currentScope)
      : null;

    if (basePersona) {
      await this.assertNoPersonaCycle(current.id, basePersona, new Set<string>());
    }

    const allowedToolNames = await listProjectPersonaAllowedToolNames(this.supabase, current.project_id);
    const nextToolAllowlist = Object.prototype.hasOwnProperty.call(input, 'tool_allowlist')
      ? validateToolAllowlist(input.tool_allowlist, allowedToolNames)
      : (Object.prototype.hasOwnProperty.call(currentConfig, 'tool_allowlist')
          ? normalizeToolAllowlist(currentConfig.tool_allowlist, allowedToolNames)
          : undefined);

    if (input.is_default) {
      await this.clearDefaultPersona(currentScope, current.id);
    }

    const config: PersonaConfig = {
      ...currentConfig,
      base_persona_id: basePersona?.id ?? null,
    };

    if (nextToolAllowlist !== undefined) {
      config.tool_allowlist = nextToolAllowlist;
    } else {
      delete config.tool_allowlist;
    }

    const nextVersionMetadata = bumpPersonaVersionMetadata(current.config, {
      personaId: current.id,
      publishedAt: new Date().toISOString(),
    });
    const nextConfig = withPersonaVersionMetadata(config, nextVersionMetadata);

    const patch: Record<string, unknown> = {
      config: nextConfig,
    };

    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.slug !== undefined) patch.slug = slugify(input.slug);
    if (input.description !== undefined) patch.description = input.description?.trim() ?? null;
    if (input.system_prompt !== undefined) patch.system_prompt = sanitizePromptValue(input.system_prompt, false) ?? '';
    if (input.style_prompt !== undefined) patch.style_prompt = sanitizePromptValue(input.style_prompt, true);
    if (input.model !== undefined) patch.model = input.model?.trim() || null;
    if (input.is_default !== undefined) patch.is_default = input.is_default;

    const { data, error } = await this.supabase
      .from('agent_personas')
      .update(patch)
      .eq('id', id)
      .select('*')
      .single();

    if (error || !data) throw error ?? new Error('persona_update_failed');

    if (input.is_default === false && current.is_default) {
      await this.promoteFallbackDefault(currentScope, basePersona?.id ?? null, id);
    }

    const decorated = await this.decoratePersona(data as PersonaRow, new Set<string>(), { includeHistory: false });
    await this.logPersonaAudit(current.org_id, current.project_id, current.agent_id, input.actorId, 'agent_persona.published', 'info', {
      persona: decorated,
      currentRow: data as PersonaRow,
      previousRow: current,
      summary: `Published persona version ${nextVersionMetadata.version_number}`,
    });

    return this.decoratePersona(data as PersonaRow);
  }

  async deletePersona(
    id: string,
    scope: Pick<PersonaScope, 'orgId' | 'projectId'>,
    actorId?: string | null,
  ): Promise<{ ok: true; id: string }> {
    const current = await this.getRawPersonaById(id, scope);
    if (current.is_builtin) {
      throw new ForbiddenError('Built-in personas cannot be deleted');
    }

    const isInUse = await this.isPersonaInUse(id);
    if (isInUse) {
      throw new ForbiddenError('Cannot delete a persona that is currently in use');
    }

    const decorated = await this.decoratePersona(current, new Set<string>(), { includeHistory: false });
    const wasDefault = current.is_default;
    const currentConfig = normalizePersonaConfig(current.config);

    const { error } = await this.supabase
      .from('agent_personas')
      .update({ deleted_at: new Date().toISOString(), is_default: false })
      .eq('id', id);

    if (error) throw error;

    if (wasDefault) {
      await this.promoteFallbackDefault({
        orgId: current.org_id,
        projectId: current.project_id,
        agentId: current.agent_id,
      }, typeof currentConfig.base_persona_id === 'string' ? currentConfig.base_persona_id : null, id);
    }

    await this.logPersonaAudit(current.org_id, current.project_id, current.agent_id, actorId ?? null, 'agent_persona.deleted', 'warn', {
      persona: decorated,
      currentRow: current,
      previousRow: current,
      summary: 'Deleted persona version',
    });

    return { ok: true, id };
  }

  private async assertAgentExists(scope: PersonaScope) {
    const { data, error } = await this.supabase
      .from('team_members')
      .select('id, type')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('id', scope.agentId)
      .maybeSingle();

    if (error) throw error;
    if (!data || data.type !== 'agent') {
      throw new NotFoundError('Agent not found in current project');
    }
  }

  private async listRawPersonas(scope: PersonaScope): Promise<PersonaRow[]> {
    const { data, error } = await this.supabase
      .from('agent_personas')
      .select('*')
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .is('deleted_at', null)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;
    return (data ?? []) as PersonaRow[];
  }

  private async getRawPersonaById(id: string, scope?: Partial<PersonaScope>): Promise<PersonaRow> {
    let query = this.supabase
      .from('agent_personas')
      .select('*')
      .eq('id', id)
      .is('deleted_at', null);

    if (scope?.orgId) query = query.eq('org_id', scope.orgId);
    if (scope?.projectId) query = query.eq('project_id', scope.projectId);
    if (scope?.agentId) query = query.eq('agent_id', scope.agentId);

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Persona not found');
    return data as PersonaRow;
  }

  private async decoratePersona(
    persona: PersonaRow,
    visited = new Set<string>(),
    options: { includeHistory?: boolean } = {},
  ): Promise<PersonaSummary> {
    const config = normalizePersonaConfig(persona.config);
    const basePersonaId = typeof config.base_persona_id === 'string' ? config.base_persona_id : null;
    const basePersona = basePersonaId && !visited.has(basePersonaId)
      ? await this.getRawPersonaById(basePersonaId, {
          orgId: persona.org_id,
          projectId: persona.project_id,
          agentId: persona.agent_id,
        })
      : null;

    const nextVisited = new Set(visited).add(persona.id);
    const decoratedBase = basePersona ? await this.decoratePersona(basePersona, nextVisited, { includeHistory: false }) : null;

    const ownSystemPrompt = sanitizePromptValue(persona.system_prompt, false) ?? '';
    const ownStylePrompt = sanitizePromptValue(persona.style_prompt, true);
    const hasOwnToolAllowlist = Object.prototype.hasOwnProperty.call(config, 'tool_allowlist');
    const toolOptions = await listProjectPersonaToolOptions(this.supabase, persona.project_id);
    const allowedToolNames = toolOptions.map((option) => option.name);
    const ownToolAllowlist = normalizeToolAllowlist(config.tool_allowlist, allowedToolNames);

    const resolvedSystemPrompt = [decoratedBase?.resolved_system_prompt, ownSystemPrompt].filter(Boolean).join('\n\n');
    const resolvedStylePrompt = [decoratedBase?.resolved_style_prompt, ownStylePrompt].filter(Boolean).join('\n\n') || null;
    const toolAllowlist = hasOwnToolAllowlist
      ? ownToolAllowlist
      : decoratedBase?.tool_allowlist ?? [...PERSONA_ALLOWED_TOOLS];
    const versionMetadata = getPersonaVersionMetadata(config, {
      personaId: persona.id,
      publishedAt: persona.updated_at || persona.created_at,
    });
    const permissionBoundary = buildPersonaPermissionBoundary(toolAllowlist, toolOptions);
    const changeHistory = options.includeHistory === false
      ? []
      : await this.getPersonaChangeHistory(persona);

    return {
      id: persona.id,
      name: persona.name,
      slug: persona.slug,
      description: persona.description,
      system_prompt: ownSystemPrompt,
      style_prompt: ownStylePrompt,
      resolved_system_prompt: resolvedSystemPrompt,
      resolved_style_prompt: resolvedStylePrompt,
      model: persona.model ?? decoratedBase?.model ?? null,
      tool_allowlist: toolAllowlist,
      base_persona_id: decoratedBase?.id ?? basePersonaId,
      base_persona: decoratedBase
        ? { id: decoratedBase.id, name: decoratedBase.name, slug: decoratedBase.slug, is_builtin: decoratedBase.is_builtin }
        : null,
      is_builtin: persona.is_builtin,
      is_default: persona.is_default,
      is_in_use: await this.isPersonaInUse(persona.id),
      version_metadata: versionMetadata,
      permission_boundary: permissionBoundary,
      change_history: changeHistory,
      created_by: persona.created_by,
      created_at: persona.created_at,
      updated_at: persona.updated_at,
    };
  }

  private async getPersonaChangeHistory(persona: PersonaRow): Promise<PersonaChangeHistoryEntry[]> {
    const { data, error } = await this.supabase
      .from('agent_audit_logs')
      .select('event_type, severity, summary, payload, created_by, created_at')
      .eq('org_id', persona.org_id)
      .eq('project_id', persona.project_id)
      .eq('agent_id', persona.agent_id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const rows = (data ?? []) as AuditRow[];
    return rows
      .filter((row) => row.event_type.startsWith('agent_persona.'))
      .filter((row) => isPayloadRecord(row.payload) && row.payload.persona_id === persona.id)
      .slice(0, 5)
      .map((row) => buildPersonaChangeHistoryEntry(row));
  }

  private async isPersonaInUse(id: string): Promise<boolean> {
    const [deploymentResult, sessionResult] = await Promise.all([
      this.supabase
        .from('agent_deployments')
        .select('id', { count: 'exact', head: true })
        .eq('persona_id', id)
        .is('deleted_at', null),
      this.supabase
        .from('agent_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('persona_id', id)
        .is('deleted_at', null),
    ]);

    if (deploymentResult.error) throw deploymentResult.error;
    if (sessionResult.error) throw sessionResult.error;

    return (deploymentResult.count ?? 0) > 0 || (sessionResult.count ?? 0) > 0;
  }

  private async clearDefaultPersona(scope: PersonaScope, exceptId?: string) {
    let query = this.supabase
      .from('agent_personas')
      .update({ is_default: false })
      .eq('org_id', scope.orgId)
      .eq('project_id', scope.projectId)
      .eq('agent_id', scope.agentId)
      .eq('is_default', true)
      .is('deleted_at', null);

    if (exceptId) query = query.neq('id', exceptId);
    const { error } = await query;
    if (error) throw error;
  }

  private async promoteFallbackDefault(scope: PersonaScope, preferredBasePersonaId?: string | null, excludeId?: string) {
    const personas = await this.listRawPersonas(scope);
    const candidates = personas.filter((persona) => persona.id !== excludeId);
    if (candidates.length === 0) return;

    const preferred = preferredBasePersonaId
      ? candidates.find((candidate) => candidate.id === preferredBasePersonaId)
      : null;
    const builtinGeneral = candidates.find((candidate) => candidate.slug === 'general' && candidate.is_builtin);
    const target = preferred ?? builtinGeneral ?? candidates[0];
    if (!target) return;

    await this.clearDefaultPersona(scope, target.id);
    const { error } = await this.supabase
      .from('agent_personas')
      .update({ is_default: true })
      .eq('id', target.id)
      .select('id')
      .single();
    if (error) throw error;
    target.is_default = true;
  }

  private async assertNoPersonaCycle(currentId: string, basePersona: PersonaRow, visited: Set<string>) {
    if (visited.has(basePersona.id)) return;
    if (basePersona.id === currentId) {
      throw new Error('Persona inheritance cycle detected');
    }

    visited.add(basePersona.id);
    const config = normalizePersonaConfig(basePersona.config);
    const nextBasePersonaId = typeof config.base_persona_id === 'string' ? config.base_persona_id : null;
    if (!nextBasePersonaId) return;

    const nextBase = await this.getRawPersonaById(nextBasePersonaId, {
      orgId: basePersona.org_id,
      projectId: basePersona.project_id,
      agentId: basePersona.agent_id,
    });
    await this.assertNoPersonaCycle(currentId, nextBase, visited);
  }

  private async logPersonaAudit(
    orgId: string,
    projectId: string,
    agentId: string,
    actorId: string | null,
    eventType: string,
    severity: 'debug' | 'info' | 'warn' | 'error' | 'security',
    input: {
      persona: PersonaSummary;
      currentRow: PersonaRow;
      previousRow: PersonaRow | null;
      summary: string;
    },
  ) {
    const payload: Record<string, unknown> = {
      persona_id: input.persona.id,
      lineage_id: input.persona.version_metadata.lineage_id,
      version_metadata: input.persona.version_metadata,
      permission_boundary: input.persona.permission_boundary,
      snapshot: {
        id: input.currentRow.id,
        name: input.currentRow.name,
        slug: input.currentRow.slug,
        description: input.currentRow.description,
        system_prompt: input.currentRow.system_prompt,
        style_prompt: input.currentRow.style_prompt,
        model: input.currentRow.model,
        config: input.currentRow.config,
        is_builtin: input.currentRow.is_builtin,
        is_default: input.currentRow.is_default,
        deleted_at: input.currentRow.deleted_at,
        updated_at: input.currentRow.updated_at,
      },
    };

    if (input.previousRow) {
      payload.previous_snapshot = {
        id: input.previousRow.id,
        name: input.previousRow.name,
        slug: input.previousRow.slug,
        description: input.previousRow.description,
        system_prompt: input.previousRow.system_prompt,
        style_prompt: input.previousRow.style_prompt,
        model: input.previousRow.model,
        config: input.previousRow.config,
        is_builtin: input.previousRow.is_builtin,
        is_default: input.previousRow.is_default,
        deleted_at: input.previousRow.deleted_at,
        updated_at: input.previousRow.updated_at,
      };
    }

    const { error } = await this.supabase
      .from('agent_audit_logs')
      .insert({
        org_id: orgId,
        project_id: projectId,
        agent_id: agentId,
        event_type: eventType,
        severity,
        summary: input.summary,
        payload,
        created_by: actorId,
      });

    if (error) throw error;
  }
}
