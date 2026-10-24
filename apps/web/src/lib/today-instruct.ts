/**
 * story #4762 (AC1) — «one press of the Today instruction line = a message on the server».
 *
 * 4758 measured it on a phone: the instruction line only moved the person to /chats?compose=… (story #3831 PO decision (c): «no receiver is
 * invented» — it hands the text to the chat's own two ways: the latest conversation's composer, or the new-conversation window). The person
 * then still had to press a second Send, and in the measurement never reached it.
 *
 * The receiver rule that does not invent one (PO 10-24, story 4762): when the person has EXACTLY ONE direct conversation with an agent, that is
 * not a choice made for them — it is the only one there is — and the line goes there as a plain message (the same server call as the chat's own
 * composer, so it reaches the agent by the same road: Dídí measured it on the Mac, +0.50 s to the app, the answer on the same DM). Anything else
 * (none, two or more, a list that cannot be read in full) keeps the old hand-over exactly as it was.
 */
import { fetchWithAuth } from '@/lib/db/client';
import { CHAT_API_PREFIX } from '@/lib/chat-api-prefix';
import { newClientNonce, sentMessageFromAnswer } from '@/hooks/use-chat-sse';

interface ParticipantLike { member_id?: unknown; type?: unknown }

/** the id of the person's one direct conversation with an agent, or null (none · more than one · a page that is not the whole list) */
export function soleAgentDm(items: unknown, selfMemberId: string, total: unknown): string | null {
  if (!Array.isArray(items) || !selfMemberId) return null;
  // the answer is a page: only a server that SAYS the count and says it is all we hold lets «exactly one» stand — a missing or unreadable count (a
  // truncated answer) is «not sure», and a second agent DM may be on a page we did not read
  if (!Number.isInteger(total) || (total as number) > items.length) return null;
  const found: string[] = [];
  for (const raw of items) {
    const c = raw as { id?: unknown; type?: unknown; participants?: unknown } | null;
    if (!c || typeof c.id !== 'string' || c.type !== 'dm' || !Array.isArray(c.participants)) continue;
    const others = (c.participants as ParticipantLike[]).filter((p) => p && p.member_id !== selfMemberId);
    if (others.length === 1 && others[0]!.type === 'agent') found.push(c.id);
  }
  return found.length === 1 ? found[0]! : null;
}

const LIST_LIMIT = 100;
const READ_TIMEOUT_MS = 8_000; // a list that does not come in time is «not sure» — the old hand-over runs
const SEND_TIMEOUT_MS = 30_000; // a send that does not answer in time is shown as not sent (the text stays), never as a button stuck for ever

/** reads the person's conversations of this project and returns their one agent DM (null on any failure — the caller then does what it always did) */
export async function findSoleAgentDm(projectId: string, selfMemberId: string): Promise<string | null> {
  try {
    const res = await fetchWithAuth(`/api/conversations?project_id=${encodeURIComponent(projectId)}&limit=${LIST_LIMIT}&offset=0`, { timeoutMs: READ_TIMEOUT_MS });
    if (!res.ok) return null;
    const json = await res.json() as { data?: unknown; total?: unknown };
    return soleAgentDm(json.data, selfMemberId, json.total);
  } catch {
    return null;
  }
}

/**
 * `sent` — the server made the message · `refused` — the server answered no (nothing was made: a retry is safe) · `unknown` — no answer (a network error or the
 * time limit): the message may or may not exist. The server only echoes `client_nonce` (it does not de-duplicate by it), so a retry after `unknown` could post the
 * line twice — the screen says «check the chat first» instead of offering a blind retry.
 */
export type SendOutcome = 'sent' | 'refused' | 'unknown';

/** sends `text` to the conversation as the chat's own composer does (`POST {CHAT_API_PREFIX}/{id}/messages`, through fetchWithAuth) */
export async function sendInstruction(conversationId: string, text: string): Promise<SendOutcome> {
  try {
    const res = await fetchWithAuth(`${CHAT_API_PREFIX}/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, client_nonce: newClientNonce() }),
      timeoutMs: SEND_TIMEOUT_MS,
    });
    if (!res.ok) return 'refused';
    // the server made the message: from here on this is a success whatever the answer's body looks like — a failure shown now would keep the text and a
    // retry would post it a second time. The answer only carries `agent_wake` (story #4761): remembered by message id, so the DM the person lands on draws
    // «this agent has to be woken» under the message (no «sent, and nothing happens»); an unreadable answer just loses that line.
    try { sentMessageFromAnswer(await res.json() as Record<string, unknown>); } catch { /* the message exists; only the extra line is lost */ }
    return 'sent';
  } catch {
    return 'unknown';
  }
}
