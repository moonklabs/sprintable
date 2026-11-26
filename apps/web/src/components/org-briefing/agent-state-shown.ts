import { shownState } from '@/components/chat/agent-session-strip';
import { limitHeld, limitLooksAgain } from '@/lib/agent-session-limit';
import { sortAgentStates, stateRank, type AgentStateRow } from '@/lib/agent-state-list';

/** story 4833 / 4950 — the Today list's rows in the list's own order and words. Its own module (story 5033: the control board reads the same ranks; a pure function, no React) — `agent-state-section` re-exports it. */
export interface Shown { row: AgentStateRow; rank: number; word: ReturnType<typeof shownState> | null }

export function toShown(rows: AgentStateRow[]): Shown[] {
  // story 4950 (the Mac app's home · PO 11-14): EVERY agent of the org gets a line. Until now an agent that was on no computer at all (made on the web and never run · no session · not bound) was left out and the strip
  // read «연결된 에이전트가 아직 없어요» beside an agent that exists — a person who just added one saw nothing. It is listed last (rank 7, «never ran») and its state is «연결 안 됨» (the agents screen's own word).
  return sortAgentStates(rows.map((row) => {
    if (row.state === null) return { row, rank: stateRank(null, false, false), word: null };
    const word = shownState(row);
    const limitShown = limitHeld(word, row.limit) || limitLooksAgain(word, row.limit) || (word === 'waiting_input' && !!row.limit?.self_resume);
    return { row, rank: stateRank(word, limitShown, !!row.first_screen?.ask && (word === 'starting' || word === 'working' || word === 'idle')), word };
  }));
}
