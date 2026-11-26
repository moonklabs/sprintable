/**
 * story 5033 (C3 · 홈 = 한눈에 관제) — the control board of the home, as a pure function. No fetch, no React, no i18n: the data layer hands in what the existing routes already give
 * (the org's projects · the epics' progress · every agent's state · who is placed where) and this decides the channel lines, the faces in them and the «열외» lane.
 *
 * The rules (each has a test that fails when it is undone):
 *  1. One line per project (a «channel»): its progress = the done stories / all stories of the project's IN-PROGRESS (`active`) epics. No epic in progress = no number (never «0/0»).
 *  2. A face stands in a channel when the agent has access to that project (a grant record); an agent with no grant in the scope stands in the «열외» lane. The scope is the whole org, or the one
 *     project the filter picked (then «열외» = «not placed in THIS project»).
 *  3. The state dot is the state the Today list already shows: the SAME rank (`stateRank`, through `toShown`) read as four words — the dot cannot disagree with the list it replaces.
 *  4. A viewer who cannot read the grants (the server said 403 — not an org admin) sees the faces and their states but no placement: the lane holds every agent and nothing can be moved.
 *  5. The only numbers: a channel's progress and its «확인 필요» count. No task list.
 */
import { toShown } from '../agent-state-shown';
import type { AgentStateRow } from '@/lib/agent-state-list';

export type FaceWord = 'working' | 'resting' | 'blocked' | 'offline';

/** the four words a face shows, from the rank the Today list already sorts by (0 limit · 1 error · 2 a person's hand · 3 working · 4 idle/starting · 5 unknown · 6 stopped · 7 never ran) */
export function faceWordFromRank(rank: number): FaceWord {
  if (rank <= 2) return 'blocked';
  if (rank === 3) return 'working';
  if (rank === 4) return 'resting';
  return 'offline';
}

export interface BoardProject { id: string; name: string }
export interface BoardEpic { projectId: string | null; status: string; total: number; done: number }

export interface BoardFace {
  agentId: string;
  name: string;
  word: FaceWord;
  /** the row the state sentence is written from (the same row the Today list reads) */
  row: AgentStateRow;
  rank: number;
}

export interface BoardChannel {
  projectId: string;
  name: string;
  /** null = no epic in progress (no number drawn) */
  progress: { done: number; total: number } | null;
  faces: BoardFace[];
  /** how many rows in «내 손이 필요해요» belong to this project */
  needsHand: number;
}

export interface ControlBoardModel {
  channels: BoardChannel[];
  /** «열외»: the agents not placed in the scope (readOnly: every agent — the placement is unknown to this viewer) */
  bench: BoardFace[];
  readOnly: boolean;
}

export const grantKey = (agentId: string, projectId: string): string => `${agentId}::${projectId}`;

export interface ControlBoardInput {
  projects: BoardProject[];
  epics: BoardEpic[];
  /** every agent of the org (system publisher already left out by the caller) */
  agents: AgentStateRow[];
  /** `${agentId}::${projectId}` → grant record id; `null` = the viewer may not read it (readOnly) */
  grants: Record<string, string> | null;
  /** null = the whole org */
  filterProjectId: string | null;
  /** project id → number of rows that need the viewer's hand */
  needsHandByProject: Record<string, number>;
}

export function deriveControlBoard(input: ControlBoardInput): ControlBoardModel {
  const { projects, epics, agents, grants, filterProjectId, needsHandByProject } = input;
  const shown = toShown(agents); // the Today list's own order and ranks
  const faces: BoardFace[] = shown.map((s) => ({ agentId: s.row.agent_id, name: s.row.agent_name, word: faceWordFromRank(s.rank), row: s.row, rank: s.rank }));
  const readOnly = grants === null;

  const scope = [...projects].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).filter((p) => filterProjectId === null || p.id === filterProjectId);

  const channels: BoardChannel[] = scope.map((p) => {
    const mine = epics.filter((e) => e.projectId === p.id && e.status === 'active' && e.total > 0);
    const total = mine.reduce((n, e) => n + e.total, 0);
    const done = mine.reduce((n, e) => n + e.done, 0);
    return {
      projectId: p.id,
      name: p.name,
      progress: total > 0 ? { done, total } : null,
      faces: readOnly ? [] : faces.filter((f) => grants[grantKey(f.agentId, p.id)] !== undefined),
      needsHand: needsHandByProject[p.id] ?? 0,
    };
  });

  const placedHere = (agentId: string): boolean => {
    if (grants === null) return false;
    return filterProjectId === null
      ? projects.some((p) => grants[grantKey(agentId, p.id)] !== undefined)
      : grants[grantKey(agentId, filterProjectId)] !== undefined;
  };
  return { channels, bench: faces.filter((f) => !placedHere(f.agentId)), readOnly };
}
