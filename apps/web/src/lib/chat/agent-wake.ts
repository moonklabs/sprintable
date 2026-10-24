/**
 * story #4761 (D3) — the send answer's `agent_wake`: the agents this message reaches only when someone makes them look (no
 * webhook, no live gateway stream — the bare hosted MCP reads Sprintable only while it calls a tool). Machine fields only
 * (`{required: [{member_id, name}]}`); the screen words it. Sent to the sender in the answer, never stored on the message.
 */
export interface AgentWakeTarget {
  member_id: string;
  name: string;
}

export interface AgentWake {
  required: AgentWakeTarget[];
}

/** At least one target with a member id or nothing — anything else from the wire is «nobody to wake» (no line is drawn). */
export function parseAgentWake(v: unknown): AgentWake | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = (v as { required?: unknown }).required;
  if (!Array.isArray(raw)) return undefined;
  const required = raw.flatMap((t): AgentWakeTarget[] => {
    const o = t as { member_id?: unknown; name?: unknown } | null;
    // an agent without a name is still an agent that needs the sentence — its name is '' and the screen says «이름 없는 에이전트»
    return o && typeof o.member_id === 'string'
      ? [{ member_id: o.member_id, name: typeof o.name === 'string' ? o.name.trim() : '' }]
      : [];
  });
  return required.length > 0 ? { required } : undefined;
}

/** The agents that still need a nudge: the ones that have said nothing after this message (an answer from them ends the line). */
export function agentsStillToWake(wake: AgentWake | undefined, later: ReadonlyArray<{ created_by: string }>): AgentWakeTarget[] {
  if (!wake) return [];
  const answered = new Set(later.map((m) => m.created_by));
  return wake.required.filter((a) => !answered.has(a.member_id));
}

// The answer to a send is the only place `agent_wake` arrives (the server does not store it), so a view that is replaced afterwards —
// the list read again, or the DM forked into a group and a new view mounted — would lose the line. The tab keeps it by message id
// (memory only, capped): whatever draws a message of mine asks here when the message itself carries none.
const RECALL_CAP = 50;
const recalled = new Map<string, AgentWake>();

export function rememberAgentWake(messageId: string, wake: AgentWake): void {
  recalled.delete(messageId);
  recalled.set(messageId, wake);
  while (recalled.size > RECALL_CAP) recalled.delete(recalled.keys().next().value as string);
}

export function recalledAgentWake(messageId: string): AgentWake | undefined {
  return recalled.get(messageId);
}
