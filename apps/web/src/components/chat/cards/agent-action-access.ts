import { EntitySummaryError } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';
import { ENTITY_CARD_KINDS, type EntityCardKind } from './card-kinds';

/**
 * story 5041 — the card of an agent's ask (a delete · a close · a grant it may not do alone): its read and its two presses. The server owns everything the card says about the ask (its words,
 * its state, who pressed): this file only carries them. Every call goes through the viewer's own session — the server runs the stored call UNDER THAT PERSON, so their own rights decide, and
 * a press that is not theirs to make comes back 403 with the request left as it was.
 */
/** `retry` = pressed once and it did not finish: pressing again continues it — the server does the same request only once, so it is safe */
export type AgentActionState = 'pending' | 'retry' | 'running' | 'executed' | 'failed' | 'rejected' | 'expired';

export interface AgentActionView {
  id: string;
  state: AgentActionState;
  /** the ask in one line, written by the server (e.g. «스프린트 «…» 닫기») */
  title: string;
  /** one line on what it means (irreversible or not), written by the server */
  prompt: string;
  /** the action cannot be taken back — the press then asks once more */
  irreversible: boolean;
  requestedBy: string | null;
  decidedBy: string | null;
  /** what the ask is about (read from the stored call's path by the server) — the card shows it and opens it; `null` = nothing to open (a grant) */
  target: { kind: EntityCardKind; id: string } | null;
  /** the action is a delete and it was done: the thing is gone, so there is nothing to open — the card says so */
  gone: boolean;
  /** the stored call found the state changed (404 · 409 · 410 · 422) — told apart from a plain failure */
  changed: boolean;
  /** the card offers «always allow» (story 5041 ②): the server says so — only to an organisation owner / admin, for an action that has an auto slot, while the ask is open */
  alwaysAllowAvailable: boolean;
}

const STATES: readonly string[] = ['pending', 'retry', 'running', 'executed', 'failed', 'rejected', 'expired'];
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameOf = (v: unknown): string | null => (obj(v) && typeof v.name === 'string' && v.name.trim() !== '' ? v.name.trim() : null);

/** the server's body → the card's picture, or `null` when it is not one (a fault worth «try again» — never a guessed card) */
export function parseAgentAction(raw: unknown): AgentActionView | null {
  if (!obj(raw) || typeof raw.id !== 'string' || typeof raw.state !== 'string' || !STATES.includes(raw.state)) return null;
  if (typeof raw.title !== 'string' || typeof raw.prompt !== 'string') return null;
  const execution = obj(raw.execution) ? raw.execution : null;
  const status = execution && typeof execution.http_status === 'number' ? execution.http_status : null;
  const rawTarget = obj(raw.target) ? raw.target : null;
  const target = rawTarget && typeof rawTarget.kind === 'string' && (ENTITY_CARD_KINDS as readonly string[]).includes(rawTarget.kind) && typeof rawTarget.id === 'string'
    ? { kind: rawTarget.kind as EntityCardKind, id: rawTarget.id }
    : null;
  return {
    id: raw.id,
    state: raw.state as AgentActionState,
    title: raw.title,
    prompt: raw.prompt,
    irreversible: raw.reversible === 'no',
    requestedBy: nameOf(raw.requested_by),
    decidedBy: nameOf(raw.decided_by),
    target,
    gone: raw.state === 'executed' && typeof raw.action_key === 'string' && raw.action_key.endsWith('.delete') && target !== null,
    changed: raw.state === 'failed' && status !== null && [404, 409, 410, 422].includes(status),
    alwaysAllowAvailable: raw.always_allow_available === true,
  };
}

export async function fetchAgentAction(requestId: string): Promise<AgentActionView> {
  const res = await fetchWithAuth(`/api/agent-actions/${encodeURIComponent(requestId)}`);
  if (!res.ok) throw new EntitySummaryError(res.status);
  const view = parseAgentAction(await res.json());
  if (!view) throw new EntitySummaryError(502);
  return view;
}

/** `forbidden` = this person may not do it (the request stays open for the next one) · `settled` = someone else already decided / it ran out (re-read) · `fault` = anything else */
export type AgentActionPress = { result: 'ok'; view: AgentActionView } | { result: 'forbidden' | 'settled' | 'fault' };

/** `alwaysAllow` = «approve AND allow this agent in this project for good» (an organisation owner / admin only — the server refuses anything else before it claims the ask) */
export async function pressAgentAction(requestId: string, decision: 'approve' | 'reject', opts?: { alwaysAllow?: boolean }): Promise<AgentActionPress> {
  try {
    const res = await fetchWithAuth(`/api/agent-actions/${encodeURIComponent(requestId)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts?.alwaysAllow ? { decision, always_allow: true } : { decision }),
    });
    if (res.status === 403) return { result: 'forbidden' };
    // 409 (someone else decided / it ran out) · 410 · 422 (it changed) · 404 (it is gone or no longer yours to see): the ask is not what this card shows — re-read it
    if (res.status === 409 || res.status === 410 || res.status === 422 || res.status === 404) return { result: 'settled' };
    if (!res.ok) return { result: 'fault' };
    const view = parseAgentAction(await res.json());
    return view ? { result: 'ok', view } : { result: 'fault' };
  } catch {
    return { result: 'fault' };
  }
}
