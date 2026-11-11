import type { SessionLimit } from '@/lib/agent-session-limit';

/**
 * story #4833 (결함 ② · design doc «4833-agent-state-on-today-design») — the rows of «에이전트 상태» on the Today screen: one row per agent, read from
 * `GET /api/v2/agents/desktop-sessions` (words and facts only — the page writes the sentences, with the words of the DM strip's own table).
 */
export interface AgentStateRow {
  agent_id: string;
  agent_name: string;
  conversation_id: string | null;
  conversation_project_id: string | null;
  bound_setup_id: string | null;
  bound_device_name: string | null;
  setup_id: string | null;
  device_name: string | null;
  state: string | null;
  activity: string | null;
  state_at: string | null;
  limit: SessionLimit | null;
  first_screen: { ask: 'trust' | 'mcp' | 'mcp_many' | 'update' } | null;
}

/** the rows an older or newer server sent, kept only when they name an agent — never a crash */
export function parseAgentStates(json: unknown): AgentStateRow[] {
  if (!Array.isArray(json)) return [];
  return json.filter((r): r is AgentStateRow => !!r && typeof r === 'object' && typeof (r as AgentStateRow).agent_id === 'string' && typeof (r as AgentStateRow).agent_name === 'string');
}

/**
 * The order on the screen (design doc §3 ③): what needs a person first. Lower = earlier.
 * ① 한도로 쉬는 중 · 사용 한도 ② 오류 ③ a person's hand (권한 · 입력 · macOS 창 · 터미널 답) ④ 작업 중 ⑤ 다음 일 기다림 · 시작됨 ⑥ 연결 끊김 ⑦ 끝 (· never ran).
 * `word` is the word the row shows (the strip's `shownState`), `limitShown` is true when the row reads as a limit.
 */
export function stateRank(word: string | null, limitShown: boolean, askingFirstScreen: boolean): number {
  if (limitShown || word === 'paused_limit') return 0;
  if (word === 'error') return 1;
  if (word === 'waiting_permission' || word === 'waiting_input' || word === 'waiting_system' || askingFirstScreen) return 2;
  if (word === 'working') return 3;
  if (word === 'idle' || word === 'starting') return 4;
  if (word === 'unknown' || word === 'unrecognized') return 5;
  if (word === 'stopped') return 6;
  return 7; // never ran (no session yet)
}

/** the screen's order: rank, then the one whose state changed last, then the name — a pure function so the order is held by a test, not by the server */
export function sortAgentStates<T extends { rank: number; row: AgentStateRow }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const at = a.row.state_at ? Date.parse(a.row.state_at) : 0;
    const bt = b.row.state_at ? Date.parse(b.row.state_at) : 0;
    if (at !== bt) return bt - at;
    return a.row.agent_name.localeCompare(b.row.agent_name) || a.row.agent_id.localeCompare(b.row.agent_id);
  });
}

/** the rows shown before «더 보기» */
export const AGENT_STATE_FIRST_SHOWN = 8;

/**
 * story 4889 (UI-6 · W1) — the team list row's state mark: which ds `StatusLabel` look the row's word wears. Pure; the WORDS stay the strip's own table
 * (`sessionStateLabel`), this only picks the mark (dot · ring · pulse · icon) so the list reads like the DM strip and the Mac board:
 * a person's hand (a permission · an input question · a macOS window · a first-screen question) → needs-hand · an error → failed · working → working ·
 * resting (a limit · starting · between turns) → idle · the computer lost / stopped / a word this page does not know → offline.
 */
export type StateMark = 'working' | 'needs-hand' | 'failed' | 'idle' | 'offline';
export function stateMark(word: string, o: { ask: boolean; limitRests: boolean }): StateMark {
  if (o.limitRests) return 'idle';
  if (o.ask && (word === 'starting' || word === 'working' || word === 'idle')) return 'needs-hand';
  switch (word) {
    case 'waiting_permission': case 'waiting_system': case 'waiting_input': return 'needs-hand';
    case 'error': return 'failed';
    case 'working': return 'working';
    case 'idle': case 'starting': case 'paused_limit': return 'idle';
    default: return 'offline'; // stopped · unknown (the computer lost) · unrecognized
  }
}
