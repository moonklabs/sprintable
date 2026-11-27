import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 5041 ② — the user's «always allow · ask first · block» for what an agent may do on its own, per action × agent × project. The server owns every rule (which actions can be allowed for good,
 * which are a person's own signature and locked, where a level comes from); this file only carries them.
 */
export type PolicyLevel = 'auto' | 'ask' | 'block';
export type PolicySource = 'default' | 'org' | 'org_agent' | 'project' | 'project_agent' | 'floor';

export interface PolicyEntry {
  actionKey: string;
  level: PolicyLevel;
  source: PolicySource;
  /** a person's own signature / approval: shown, never changed */
  locked: boolean;
  /** whether this action has an «always allow» slot at all */
  autoAllowed: boolean;
}

const LEVELS: readonly string[] = ['auto', 'ask', 'block'];
const SOURCES: readonly string[] = ['default', 'org', 'org_agent', 'project', 'project_agent', 'floor'];
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** the server's body → the entries, or `null` when it is not one (never a guessed list) */
export function parsePolicy(raw: unknown): PolicyEntry[] | null {
  if (!obj(raw) || !Array.isArray(raw.actions)) return null;
  const out: PolicyEntry[] = [];
  for (const a of raw.actions) {
    if (!obj(a) || typeof a.action_key !== 'string' || typeof a.level !== 'string' || !LEVELS.includes(a.level) || typeof a.source !== 'string' || !SOURCES.includes(a.source)) return null;
    out.push({ actionKey: a.action_key, level: a.level as PolicyLevel, source: a.source as PolicySource, locked: a.locked === true, autoAllowed: a.auto_allowed === true });
  }
  return out;
}

export type PolicyRead = { result: 'ok'; entries: PolicyEntry[] } | { result: 'forbidden' | 'fault' };

export async function fetchPolicy(agentId: string, projectId: string): Promise<PolicyRead> {
  try {
    const res = await fetchWithAuth(`/api/agent-action-policy?project_id=${encodeURIComponent(projectId)}&agent_id=${encodeURIComponent(agentId)}`);
    if (res.status === 403) return { result: 'forbidden' };
    if (!res.ok) return { result: 'fault' };
    const entries = parsePolicy(await res.json());
    return entries ? { result: 'ok', entries } : { result: 'fault' };
  } catch {
    return { result: 'fault' };
  }
}

/** one setting for THIS agent in THIS project — `true` when the server kept it */
export async function setPolicy(agentId: string, projectId: string, actionKey: string, level: PolicyLevel): Promise<boolean> {
  try {
    const res = await fetchWithAuth('/api/agent-action-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action_key: actionKey, level, project_id: projectId, agent_id: agentId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** take this agent's own setting for this project back — what a wider scope (or the default) says applies again */
export async function clearPolicy(agentId: string, projectId: string, actionKey: string): Promise<boolean> {
  try {
    const res = await fetchWithAuth(`/api/agent-action-policy?action_key=${encodeURIComponent(actionKey)}&project_id=${encodeURIComponent(projectId)}&agent_id=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
