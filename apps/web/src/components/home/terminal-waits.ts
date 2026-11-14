import { shownState } from '@/components/chat/agent-session-strip';
import type { AgentStateRow } from '@/lib/agent-state-list';

/**
 * story #4931 — an agent that stands at a question in a Mac terminal (the «trust this folder» · MCP · update window) waits for a PERSON, so the home counts it in «손 필요».
 * Only the person at THAT Mac can answer, so only a session on the reader's OWN computer counts (`device_is_mine === true` — an older server that does not say, or someone else's computer, never counts;
 * the wait of another person's Mac stays in «에이전트 상태» only). The same facts the «에이전트 상태» line reads (`first_screen.ask` while the session is starting · working · idle), so the two never disagree.
 */
export interface HomeTerminalWait {
  agentId: string;
  agentName: string;
  deviceName: string | null;
  /** when the state last changed (ISO) — the wait's start as far as the server says; '' when it did not say */
  since: string;
  conversationId: string | null;
  conversationProjectId: string | null;
}

export function toTerminalWaits(rows: AgentStateRow[]): HomeTerminalWait[] {
  return rows
    .filter((r) => {
      if (r.device_is_mine !== true || !r.first_screen?.ask) return false;
      const word = shownState(r);
      return word === 'starting' || word === 'working' || word === 'idle';
    })
    .map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      deviceName: r.device_name ?? r.bound_device_name,
      since: r.state_at ?? '',
      conversationId: r.conversation_id,
      conversationProjectId: r.conversation_project_id,
    }));
}
