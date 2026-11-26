/**
 * story 5033 (C3) — the control board's pure rules. Each test fails when its rule is undone.
 */
import { describe, expect, it } from 'vitest';
import type { AgentStateRow } from '@/lib/agent-state-list';
import { toShown } from '../agent-state-shown';
import { deriveControlBoard, faceWordFromRank, grantKey, type BoardEpic, type BoardProject } from './derive-control-board';

const P1: BoardProject = { id: 'p1', name: 'Alpha' };
const P2: BoardProject = { id: 'p2', name: 'Beta' };
const P3: BoardProject = { id: 'p3', name: 'Gamma' };

function row(name: string, over: Partial<AgentStateRow> = {}): AgentStateRow {
  return {
    agent_id: `id-${name}`, agent_name: name, conversation_id: null, conversation_project_id: null, bound_setup_id: 's', bound_device_name: 'mac', setup_id: 's', device_name: 'mac',
    state: 'working', activity: 'working', state_at: '2026-11-26T00:00:00Z', limit: null, first_screen: null, ...over,
  };
}
const epic = (projectId: string | null, total: number, done: number, status = 'active'): BoardEpic => ({ projectId, status, total, done });
const base = { projects: [P1, P2], epics: [] as BoardEpic[] | null, agents: [] as AgentStateRow[], grants: {} as Record<string, string>, filterProjectId: null as string | null, needsHandByProject: {} as Record<string, number> };

describe('progress = the done stories / all stories of the project\'s IN-PROGRESS epics', () => {
  it('⭐sums only the active epics of that project (a finished epic and another project\'s epic do not count)', () => {
    const m = deriveControlBoard({ ...base, epics: [epic('p1', 10, 4), epic('p1', 5, 5), epic('p1', 100, 100, 'done'), epic('p2', 8, 1), epic(null, 50, 50)] });
    expect(m.channels.map((c) => [c.projectId, c.progress])).toEqual([['p1', { done: 9, total: 15 }], ['p2', { done: 1, total: 8 }]]);
  });
  it('⭐a project with no epic in progress has NO number (never «0/0»)', () => {
    const m = deriveControlBoard({ ...base, epics: [epic('p2', 8, 1), epic('p1', 100, 100, 'done'), epic('p1', 0, 0)] });
    expect(m.channels.find((c) => c.projectId === 'p1')!.progress).toBeNull();
  });
  it('⭐an unreadable epics read = «unknown» on every channel, never «none in progress»', () => {
    const m = deriveControlBoard({ ...base, epics: null });
    expect(m.channels.map((c) => [c.progress, c.progressUnknown])).toEqual([[null, true], [null, true]]);
    expect(deriveControlBoard({ ...base, epics: [] }).channels.map((c) => c.progressUnknown)).toEqual([false, false]);
  });
  it('channels are ordered by project name (not by the order the server listed them)', () => {
    const m = deriveControlBoard({ ...base, projects: [P3, P2, P1] });
    expect(m.channels.map((c) => c.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('who stands where', () => {
  const agents = [row('Ann'), row('Bo'), row('Cy')];
  const grants = { [grantKey('id-Ann', 'p1')]: 'r1', [grantKey('id-Ann', 'p2')]: 'r2', [grantKey('id-Bo', 'p2')]: 'r3' };

  it('⭐a face stands in every channel its agent has access to; an agent with no access anywhere stands in «열외»', () => {
    const m = deriveControlBoard({ ...base, agents, grants });
    expect(m.channels.map((c) => [c.name, c.faces.map((f) => f.name).sort()])).toEqual([['Alpha', ['Ann']], ['Beta', ['Ann', 'Bo']]]);
    expect(m.bench.map((f) => f.name)).toEqual(['Cy']);
  });
  it('⭐with the project filter: one channel only, and «열외» = the agents NOT placed in that project', () => {
    const m = deriveControlBoard({ ...base, agents, grants, filterProjectId: 'p1' });
    expect(m.channels.map((c) => c.projectId)).toEqual(['p1']);
    expect(m.channels[0]!.faces.map((f) => f.name)).toEqual(['Ann']);
    expect(m.bench.map((f) => f.name).sort()).toEqual(['Bo', 'Cy']);
  });
  it('⭐a viewer who cannot read the placement (grants = null) → no face in any channel, every agent listed once in the lane, readOnly', () => {
    const m = deriveControlBoard({ ...base, agents, grants: null });
    expect(m.readOnly).toBe(true);
    expect(m.channels.every((c) => c.faces.length === 0)).toBe(true);
    expect(m.bench.map((f) => f.name).sort()).toEqual(['Ann', 'Bo', 'Cy']);
  });
  it('a channel carries its own «확인 필요» count (and 0 when none)', () => {
    const m = deriveControlBoard({ ...base, needsHandByProject: { p2: 3 } });
    expect(m.channels.map((c) => c.needsHand)).toEqual([0, 3]);
  });
});

describe('the state dot is the SAME state the Today list shows (one source)', () => {
  const CASES: Array<[string, Partial<AgentStateRow>, ReturnType<typeof faceWordFromRank>]> = [
    ['working', { state: 'working', activity: 'working' }, 'working'],
    ['idle', { state: 'idle', activity: 'idle' }, 'resting'],
    ['starting', { state: 'starting', activity: 'starting' }, 'resting'],
    ['waiting_permission', { state: 'working', activity: 'waiting_permission' }, 'blocked'],
    ['waiting_input', { state: 'working', activity: 'waiting_input' }, 'blocked'],
    ['waiting_system', { state: 'working', activity: 'waiting_system' }, 'blocked'],
    ['error', { state: 'error', activity: 'error' }, 'blocked'],
    ['stopped', { state: 'stopped', activity: 'stopped' }, 'offline'],
    ['never ran (no session)', { state: null, activity: null }, 'offline'],
    ['a word this build does not know', { state: 'brand_new_word', activity: null }, 'offline'],
  ];
  for (const [label, over, word] of CASES) {
    it(`⭐${label} → ${word}`, () => {
      const r = row('Ann', over);
      const m = deriveControlBoard({ ...base, agents: [r], grants: null });
      const shownRank = toShown([r])[0]!.rank;
      expect(m.bench[0]!.rank).toBe(shownRank); // the list's own rank, not a second table
      expect(m.bench[0]!.word).toBe(word);
    });
  }
  it('⭐a limit pause reads «막힘» (it is rank 0 of the list)', () => {
    const r = row('Ann', { state: 'idle', activity: 'paused_limit', limit: { reset_at: null } as never });
    expect(deriveControlBoard({ ...base, agents: [r], grants: null }).bench[0]!.word).toBe('blocked');
  });
  it('the four words come from the rank ranges 0–2 / 3 / 4 / 5–7', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(faceWordFromRank)).toEqual(['blocked', 'blocked', 'blocked', 'working', 'resting', 'offline', 'offline', 'offline']);
  });
  it('faces keep the Today list\'s order (a blocked agent first)', () => {
    const m = deriveControlBoard({ ...base, agents: [row('Zed', { state: 'idle', activity: 'idle' }), row('Amy', { state: 'error', activity: 'error' })], grants: null });
    expect(m.bench.map((f) => f.name)).toEqual(['Amy', 'Zed']);
  });
});
