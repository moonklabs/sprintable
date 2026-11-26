import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

// story 5036 (C6 · step ③ of the straight line — the web and the Mac app both): «첫 대화» opens THE PROJECT'S CHANNEL — the room the server gives every project (one per project,
// `is_project_channel`, story 5032), where the agents that hold the project sit as participants. That is the project the first step made, so the first conversation is where
// the project's work will be. When the channel cannot be found (the list could not be read, an older server without channels) the way before it is kept — a DM with the
// agent that connected (story 3201) — and when that cannot be opened either the page's own way out is the answer: never a dead end.

/** a page of the project's rooms, and how many pages are read at most to find its channel (a project that has just been made has a handful; a long-lived one is read through, not guessed) */
const READ_LIMIT = 50;
const READ_PAGES = 10;

/** the id of the project's channel room, or null (not there · could not be read) */
export async function findProjectChannelId(projectId: string): Promise<string | null> {
  for (let page = 0; page < READ_PAGES; page += 1) {
    const res = await fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}&include_agent_conversations=true&limit=${READ_LIMIT}&offset=${page * READ_LIMIT}`).catch(() => null);
    if (!res || !res.ok) return null;
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) return null;
    for (const row of body.data) {
      const r = row as { id?: unknown; is_project_channel?: unknown } | null;
      if (r && r.is_project_channel === true && typeof r.id === 'string' && r.id) return r.id;
    }
    if (body.data.length < READ_LIMIT) return null; // the last page: not there
  }
  return null;
}

/** the room the first conversation opens: the project's channel, else a new DM with the agent (the way before channels); null = neither could be opened */
export async function openFirstChatRoom(projectId: string, agentId: string | null): Promise<string | null> {
  const channel = await findProjectChannelId(projectId);
  if (channel) return channel;
  return createFirstInstructionConversation(projectId, agentId);
}
