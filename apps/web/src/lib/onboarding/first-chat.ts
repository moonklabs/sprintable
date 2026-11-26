import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

// story 5036 (C6 · step ③ of the straight line — the web and the Mac app both): «첫 대화» opens THE PROJECT'S CHANNEL — the room the server gives every project (one per project,
// `is_project_channel`, story 5032), where the agents that hold the project sit as participants. That is the project the first step made, so the first conversation is where
// the project's work will be. When the channel cannot be found (the list could not be read, an older server without channels) the way before it is kept — a DM with the
// agent that connected (story 3201) — and when that cannot be opened either the page's own way out is the answer: never a dead end.

/** the id of the project's channel room, or null (not there · could not be read) */
export async function findProjectChannelId(projectId: string): Promise<string | null> {
  // the project's own rooms, read once: the server answers `project_id=` with that project's rooms only, and its channel is the one row marked `is_project_channel` (PO 11-26, measured on dev) —
  // no page walk and no guess from a stale mark: the project asked for is the project of step ①
  const res = await fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}`).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) return null;
  for (const row of body.data) {
    const r = row as { id?: unknown; is_project_channel?: unknown } | null;
    if (r && r.is_project_channel === true && typeof r.id === 'string' && r.id) return r.id;
  }
  return null;
}

/** the room the first conversation opens: the project's channel, else a new DM with the agent (the way before channels); null = neither could be opened */
export async function openFirstChatRoom(projectId: string, agentId: string | null): Promise<string | null> {
  const channel = await findProjectChannelId(projectId);
  if (channel) return channel;
  return createFirstInstructionConversation(projectId, agentId);
}
