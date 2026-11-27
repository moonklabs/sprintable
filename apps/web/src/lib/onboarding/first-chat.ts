import { fetchWithAuth } from '@/lib/db/client';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';

// story 5036 (C6 · step ③ of the straight line — the web and the Mac app both): «첫 대화» opens THE PROJECT'S CHANNEL — the room the server gives every project (one per project,
// `is_project_channel`, story 5032), where the agents that hold the project sit as participants. That is the project the first step made, so the first conversation is where
// the project's work will be. When the channel cannot be found (the list could not be read, an older server without channels) the way before it is kept — a DM with the
// agent that connected (story 3201) — and when that cannot be opened either the page's own way out is the answer: never a dead end.

const FIND_CHANNEL_PAGE = 100;

/** the id of the project's channel room, or null (not there · could not be read) */
export async function findProjectChannelId(projectId: string): Promise<string | null> {
  // the project's own rooms, read once: the server answers `project_id=` with that project's rooms only, and its channel is the one row marked `is_project_channel` (PO 11-26, measured on dev) —
  // no page walk and no guess from a stale mark: the project asked for is the project of step ①
  // PO 11-26: ONE read of the project's own rooms — no page walk. The server's default page is 30 rooms, and a project with many direct rooms could hold its channel past that (codex 5036), so the same single
  // read asks for a bigger page (100): not a walk, one request. A project with more than 100 rooms is the remaining edge (told to the PO) — then the direct room opens, never a dead end.
  const res = await fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}&limit=${FIND_CHANNEL_PAGE}`).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) return null;
  for (const row of body.data) {
    const r = row as { id?: unknown; is_project_channel?: unknown } | null;
    if (r && r.is_project_channel === true && typeof r.id === 'string' && r.id) return r.id;
  }
  return null;
}

/** how long the setup's end waits to find the project's channel before it opens the start's own conversation (the person is on a progress screen: a short wait is fine, a long one is not) */
export const SETUP_END_ROOM_MAX_MS = 5_000;

/**
 * story 5036 (C6 · PO 11-27): where the setup's END opens for someone who did not come through the first-run line (no mark) — the project the agent really sits in. The server's start made a direct room with the agent
 * (`dmId`); that room names its project, and the project's channel is the first conversation (the same room step ③ opens). The room's own project is the answer to «which project»: no guess from the tab's project
 * or from a stale mark. Anything that cannot be read in time (the room's answer · the channel list · a room with no project) opens the start's own conversation, exactly as before — never a dead end, never a wait.
 */
export async function setupEndRoomId(dmId: string, maxMs: number = SETUP_END_ROOM_MAX_MS): Promise<string> {
  const find = async (): Promise<string> => {
    const res = await fetchWithAuth(`/api/conversations/${encodeURIComponent(dmId)}`).catch(() => null);
    if (!res || !res.ok) return dmId;
    const conv = (await res.json().catch(() => null)) as { project_id?: unknown } | null;
    const project = conv && typeof conv.project_id === 'string' && conv.project_id !== '' ? conv.project_id : null;
    if (!project) return dmId;
    return (await findProjectChannelId(project)) ?? dmId;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([find().catch(() => dmId), new Promise<string>((resolve) => { timer = setTimeout(() => resolve(dmId), maxMs); })]);
  if (timer !== undefined) clearTimeout(timer);
  return out;
}

/** the room the first conversation opens: the project's channel, else a new DM with the agent (the way before channels); null = neither could be opened */
export async function openFirstChatRoom(projectId: string, agentId: string | null): Promise<string | null> {
  const channel = await findProjectChannelId(projectId);
  if (channel) return channel;
  return createFirstInstructionConversation(projectId, agentId);
}
