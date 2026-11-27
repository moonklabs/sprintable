import { fetchWithAuth } from '@/lib/db/client';
import { CHAT_API_PREFIX } from '@/lib/chat-api-prefix';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { newClientNonce } from '@/hooks/use-chat-sse';
import type { QuickPost, QuickTargetView } from '@/lib/quick/quick-view';

// story 5047 (C14 · PO 11-27): what the quick-ask page asks of the server — the places a line can go (this project's agents and its channel) and the send itself. The send answers with the server's STATUS
// (or null when nothing answered): the Mac app's window closes only on a 2xx, so this file never turns an answer into «ok / not ok» — it passes the number on.

const READ_TIMEOUT_MS = 8_000;
const SEND_TIMEOUT_MS = 30_000;
const PAGE = 100;
const MAX_PAGES = 20;

export type TargetsResult =
  | { ok: true; projectId: string; targets: QuickTargetView[] }
  | { ok: false; reason: 'login' | 'failed' };

interface Row { id?: unknown; name?: unknown; runtime_type?: unknown }

/** this project's places to send: its channel (named by the project, first) and its agents */
export async function loadQuickTargets(): Promise<TargetsResult> {
  try {
    const cur = await fetchWithAuth('/api/current-project', { timeoutMs: READ_TIMEOUT_MS });
    if (cur.status === 401) return { ok: false, reason: 'login' };
    if (!cur.ok) return { ok: false, reason: 'failed' };
    const curJson = (await cur.json()) as { data?: { project_id?: unknown; project_name?: unknown } };
    const projectId = curJson.data?.project_id;
    const projectName = curJson.data?.project_name;
    if (typeof projectId !== 'string' || projectId === '') return { ok: false, reason: 'failed' };
    const [agentsRes, roomsRes] = await Promise.all([
      fetchWithAuth(`/api/team-members?project_id=${encodeURIComponent(projectId)}&type=agent`, { timeoutMs: READ_TIMEOUT_MS }),
      fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}&limit=${PAGE}&offset=0`, { timeoutMs: READ_TIMEOUT_MS }),
    ]);
    if (agentsRes.status === 401 || roomsRes.status === 401) return { ok: false, reason: 'login' };
    if (!agentsRes.ok) return { ok: false, reason: 'failed' };
    const targets: QuickTargetView[] = [];
    // the channel is a bonus: a list that cannot be read leaves the agents (a line to an agent still works)
    if (roomsRes.ok) {
      const rooms = ((await roomsRes.json().catch(() => null)) as { data?: unknown } | null)?.data;
      if (Array.isArray(rooms)) {
        const ch = rooms.find((r) => (r as { is_project_channel?: unknown } | null)?.is_project_channel === true) as { id?: unknown } | undefined;
        if (ch && typeof ch.id === 'string' && ch.id !== '') targets.push({ kind: 'channel', id: ch.id, name: typeof projectName === 'string' && projectName !== '' ? projectName : '' });
      }
    }
    const agents = ((await agentsRes.json()) as { data?: Row[] }).data ?? [];
    for (const a of agents) {
      if (typeof a.id !== 'string' || a.id === '' || typeof a.name !== 'string' || a.name === '') continue;
      if (isSystemPublisher(typeof a.runtime_type === 'string' ? a.runtime_type : null)) continue; // an internal member is no one to ask
      targets.push({ kind: 'agent', id: a.id, name: a.name });
    }
    return { ok: true, projectId, targets };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

interface ConvRow { id?: unknown; type?: unknown; status?: unknown; updated_at?: unknown; latest_message?: { created_at?: unknown } | null; participants?: { member_id?: unknown; departed?: unknown }[] }

/** the person's newest OPEN direct room with this agent, or null — the server makes a NEW room on every «start a chat», so a line to an agent goes to the room that already exists */
export function pickDmWithAgent(rows: unknown, agentId: string): string | null {
  if (!Array.isArray(rows)) return null;
  let best: { id: string; at: string } | null = null;
  for (const raw of rows as (ConvRow | null)[]) {
    if (!raw || raw.type !== 'dm' || typeof raw.id !== 'string') continue;
    if (typeof raw.status === 'string' && raw.status !== 'open') continue; // resolved or closed rooms are not where a new line goes
    if (!(raw.participants ?? []).some((p) => p && p.member_id === agentId && p.departed !== true)) continue;
    const at = typeof raw.latest_message?.created_at === 'string' ? raw.latest_message.created_at : typeof raw.updated_at === 'string' ? raw.updated_at : '';
    if (!best || at > best.at) best = { id: raw.id, at };
  }
  return best?.id ?? null;
}

type Room = { id: string } | { status: number | null };

async function roomForAgent(agentId: string, projectId: string): Promise<Room> {
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}&limit=${PAGE}&offset=${page * PAGE}`, { timeoutMs: READ_TIMEOUT_MS });
    if (!res.ok) return { status: res.status }; // the list cannot be read: a room must not be made on a guess (a second room would split the talk)
    const json = (await res.json()) as { data?: unknown; total?: unknown };
    const found = pickDmWithAgent(json.data, agentId);
    if (found) return { id: found };
    const seen = (page + 1) * PAGE;
    const total = typeof json.total === 'number' ? json.total : 0;
    if (!Array.isArray(json.data) || json.data.length === 0 || seen >= total) { reachedEnd = true; break; }
  }
  // the pages ran out before the list ended (more rooms than the walk reads): «no DM with this agent» is NOT known — a second room would split the talk, so nothing is made and the failure is shown (codex 5047)
  if (!reachedEnd) return { status: 503 };
  const made = await fetchWithAuth('/api/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: SEND_TIMEOUT_MS,
    body: JSON.stringify({ type: 'dm', participant_ids: [agentId], project_id: projectId }),
  });
  if (!made.ok) return { status: made.status };
  const id = ((await made.json().catch(() => null)) as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id !== '' ? { id } : { status: 502 };
}

/** a `data:image/…;base64,…` address → a file (decoded here: the page's own request rules never load a data: address) */
export function pictureToFile(dataUrl: string): File | null {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], m[1] === 'image/png' ? 'window.png' : 'window.jpg', { type: m[1] });
  } catch {
    return null;
  }
}

/**
 * sends the line (and the picture) and answers with the server's status — the number of the answer that decides: the room lookup or creation if that failed, the picture's upload if that failed,
 * else the message's own. null = nothing answered (offline · timed out). The message is sent LAST, so a failed step before it leaves nothing half-sent.
 */
export async function quickSend(post: QuickPost, projectId: string | null): Promise<number | null> {
  try {
    let roomId = post.target.kind === 'channel' ? post.target.id : null;
    if (!roomId) {
      let project = projectId;
      if (!project) {
        const cur = await fetchWithAuth('/api/current-project', { timeoutMs: READ_TIMEOUT_MS });
        if (!cur.ok) return cur.status;
        const p = ((await cur.json()) as { data?: { project_id?: unknown } }).data?.project_id;
        if (typeof p !== 'string' || p === '') return 502;
        project = p;
      }
      const room = await roomForAgent(post.target.id, project);
      if ('status' in room) return room.status;
      roomId = room.id;
    }
    let attachments: unknown[] | undefined;
    if (post.picture) {
      const file = pictureToFile(post.picture);
      if (!file) return 422; // a picture that cannot be read is not sent without it: the person sees the failure and the picture stays in the window
      const form = new FormData();
      form.append('file', file);
      const up = await fetchWithAuth(`${CHAT_API_PREFIX}/${encodeURIComponent(roomId)}/attachments`, { method: 'POST', body: form, timeoutMs: SEND_TIMEOUT_MS });
      if (!up.ok) return up.status;
      attachments = [await up.json()];
    }
    const res = await fetchWithAuth(`${CHAT_API_PREFIX}/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: SEND_TIMEOUT_MS,
      body: JSON.stringify({ content: post.text, client_nonce: newClientNonce(), ...(attachments ? { attachments } : {}) }),
    });
    return res.status;
  } catch {
    return null;
  }
}
