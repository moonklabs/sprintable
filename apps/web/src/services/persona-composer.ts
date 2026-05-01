// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { BUILTIN_AGENT_TOOL_NAMES } from './agent-builtin-tool-names';
import { listProjectApprovedMcpToolOptions } from './project-mcp';

export interface PersonaToolOption {
  name: string;
  source: 'builtin' | 'mcp';
  groupKind: 'builtin' | 'mcp' | 'github';
  serverName: string | null;
}

export function estimatePromptTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function resolvePersonaToolOptions(rawConfig: unknown): PersonaToolOption[] {
  void rawConfig;
  return BUILTIN_AGENT_TOOL_NAMES.map((name) => ({
    name,
    source: 'builtin',
    groupKind: 'builtin',
    serverName: null,
  }));
}

export async function listProjectPersonaToolOptions(_supabase: SupabaseClient, projectId: string): Promise<PersonaToolOption[]> {
  const builtinOptions = resolvePersonaToolOptions(null);

  let approvedOptions: Array<{ name: string; serverName: string; groupKind: 'mcp' | 'github' }> = [];
  try {
    approvedOptions = await listProjectApprovedMcpToolOptions(createSupabaseAdminClient() as never, projectId);
  } catch {
    approvedOptions = [];
  }

  const deduped = new Map<string, PersonaToolOption>();
  [...builtinOptions, ...approvedOptions.map((option) => ({
    name: option.name,
    source: 'mcp' as const,
    groupKind: option.groupKind,
    serverName: option.serverName,
  }))].forEach((option) => {
    if (!deduped.has(option.name)) {
      deduped.set(option.name, option);
    }
  });

  return [...deduped.values()];
}

export async function listProjectPersonaAllowedToolNames(supabase: SupabaseClient, projectId: string): Promise<string[]> {
  const options = await listProjectPersonaToolOptions(supabase, projectId);
  return options.map((option) => option.name);
}
