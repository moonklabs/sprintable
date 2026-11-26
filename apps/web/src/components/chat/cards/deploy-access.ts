import { EntitySummaryError } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 5034 (C4 step 3b) — the «배치 · 열외» card's reads and its two writes. «Place» = give THIS agent access to THIS project (`POST /projects/{id}/access`), «take out» = take that access back
 * (`DELETE /projects/{id}/access/{record}`) — the project's access list, nothing org-wide (an agent is never deactivated from a card). Every call goes through the viewer's own session and the
 * SERVER decides (403 unless an org owner/admin or the project's admin): what this file does before that is only to not offer a button that cannot work. Bodies are read in their one `{ data }` shape.
 */
export interface DeploySummary {
  name: string | null;
  active: boolean;
  /** `granted` / `none` = read from the project's access list (the viewer may read it) · `unknown` = the viewer may not read it (the card then shows the name only) */
  access: 'granted' | 'none' | 'unknown';
  /** the access record to take back — only when `access === 'granted'` */
  recordId: string | null;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
async function dataOf(res: Response): Promise<unknown> {
  if (!res.ok) throw new EntitySummaryError(res.status);
  return ((await res.json()) as { data?: unknown }).data;
}

/** `mayRead`: the viewer's role may read the project's access list at all (org owner/admin) — the list is only asked for then (a member would get nothing but a 403) */
export async function fetchDeploySummary(agentId: string, projectId: string | null, mayRead: boolean): Promise<DeploySummary> {
  const member = await dataOf(await fetchWithAuth(`/api/team-members/${encodeURIComponent(agentId)}`));
  if (!obj(member)) throw new EntitySummaryError(502); // not the one `{ data: {...} }` shape: a fault worth a «try again»
  // a reference to a person is not an agent card: the same «not found» as an agent the viewer cannot see
  if (member.type !== 'agent') throw new EntitySummaryError(404);
  const name = typeof member.name === 'string' && member.name.trim() !== '' ? member.name.trim() : null;
  const active = member.is_active === true;
  if (!projectId || !mayRead) return { name, active, access: 'unknown', recordId: null };
  const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/access`);
  if (res.status === 403) return { name, active, access: 'unknown', recordId: null }; // the server says this viewer may not read it: the name only
  const rows = await dataOf(res);
  if (!Array.isArray(rows)) throw new EntitySummaryError(502);
  const mine = rows.find((r): r is Record<string, unknown> => obj(r) && r.member_id === agentId && typeof r.id === 'string');
  return mine ? { name, active, access: 'granted', recordId: mine.id as string } : { name, active, access: 'none', recordId: null };
}

/** `ok` includes «already» (409 on a place, 404 on a take-back): the picture after the next read is the truth */
export type DeployWriteResult = 'ok' | 'forbidden' | 'invalid' | 'fault';
const result = (status: number, okExtra: readonly number[]): DeployWriteResult => (status >= 200 && status < 300) || okExtra.includes(status) ? 'ok' : status === 403 ? 'forbidden' : status === 400 || status === 422 ? 'invalid' : 'fault';

export async function placeAgent(projectId: string, agentId: string): Promise<DeployWriteResult> {
  try {
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: agentId, org_member_id: null, permission: 'granted' }) });
    return result(res.status, [409]);
  } catch { return 'fault'; }
}

export async function takeAgentOut(projectId: string, recordId: string): Promise<DeployWriteResult> {
  try {
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
    return result(res.status, [404]);
  } catch { return 'fault'; }
}
