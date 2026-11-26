import { EntitySummaryError } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story 5034 (C4 step 3b) — the «넣기 · 빼기» card's reads and its two writes. «Place» = give THIS agent access to THIS project (`POST /projects/{id}/access`), «take out» = take that access back
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const mine = rows.find((r): r is Record<string, unknown> => obj(r) && r.member_id === agentId);
  if (mine && !(typeof mine.id === 'string' && UUID_RE.test(mine.id))) throw new EntitySummaryError(502); // the agent's row without a usable record id: a fault worth «try again» — never «in this project» with a take-back that points nowhere
  return mine ? { name, active, access: 'granted', recordId: mine.id as string } : { name, active, access: 'none', recordId: null };
}

/** `ok` includes «already» (409 on a place, 404 on a take-back): the picture after the next read is the truth */
export type DeployWriteResult = 'ok' | 'forbidden' | 'invalid' | 'fault';
/** what a write answered: `result`, and — only for a clean 2xx — the picture it makes true (`placed`: the new record's id · `taken`), so the card can say it at once instead of trusting a read that may still see the old rows */
export interface DeployWrite { result: DeployWriteResult; applied: { access: 'granted'; recordId: string } | { access: 'none'; recordId: null } | null }
const result = (status: number, okExtra: readonly number[]): DeployWriteResult => (status >= 200 && status < 300) || okExtra.includes(status) ? 'ok' : status === 403 ? 'forbidden' : status === 400 || status === 422 ? 'invalid' : 'fault';

export async function placeAgent(projectId: string, agentId: string): Promise<DeployWrite> {
  try {
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ member_id: agentId, org_member_id: null, permission: 'granted' }) });
    const r = result(res.status, [409]);
    if (r !== 'ok' || res.status !== 201) return { result: r, applied: null }; // only a 201 (the route's created-record answer) names the new record; any other 2xx / «already» → the card re-reads
    // a created record names itself (`{ data: { id } }`); an answer without one is not claimed — the card re-reads instead
    let id: unknown = null;
    try { const d = ((await res.json()) as { data?: unknown }).data; id = obj(d) ? d.id : null; } catch { /* no usable body */ }
    return { result: 'ok', applied: typeof id === 'string' && UUID_RE.test(id) ? { access: 'granted', recordId: id } : null };
  } catch { return { result: 'fault', applied: null }; }
}

export async function takeAgentOut(projectId: string, recordId: string): Promise<DeployWrite> {
  try {
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/access/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
    const r = result(res.status, [404]);
    return { result: r, applied: r === 'ok' && res.status !== 404 ? { access: 'none', recordId: null } : null };
  } catch { return { result: 'fault', applied: null }; }
}
