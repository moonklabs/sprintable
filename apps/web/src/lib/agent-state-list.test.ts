// story #4833 — the pure parts of the Today list: what is kept from a server answer, and the rank of each word
import { describe, expect, it } from 'vitest';
import { parseAgentStates, sortAgentStates, stateMark, stateRank, type AgentStateRow } from './agent-state-list';

describe('parseAgentStates', () => {
  it('keeps only rows that name an agent; anything else (null · a string · an object) is an empty list — never a crash', () => {
    expect(parseAgentStates(null)).toEqual([]);
    expect(parseAgentStates('x')).toEqual([]);
    expect(parseAgentStates({ agent_id: 'a' })).toEqual([]);
    const ok = { agent_id: 'a', agent_name: 'A' };
    expect(parseAgentStates([ok, null, 3, { agent_id: 1, agent_name: 'B' }, { agent_name: 'C' }])).toEqual([ok]);
  });
});

describe('stateRank', () => {
  it('is strictly ordered limit < error < a person\'s hand < working < idle · starting < lost < ended < never', () => {
    const ranks = [
      stateRank('paused_limit', false, false), stateRank('error', false, false), stateRank('waiting_input', false, false),
      stateRank('working', false, false), stateRank('idle', false, false), stateRank('unknown', false, false),
      stateRank('stopped', false, false), stateRank(null, false, false),
    ];
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
    expect(stateRank('starting', false, false)).toBe(stateRank('idle', false, false));
    expect(stateRank('working', true, false)).toBe(stateRank('paused_limit', false, false)); // a Claude limit shown as «사용 한도» ranks as a limit
    expect(stateRank('working', false, true)).toBe(stateRank('waiting_permission', false, false)); // a question standing at the terminal needs a person
  });
});

describe('sortAgentStates', () => {
  const r = (name: string, at: string | null) => ({ agent_id: name, agent_name: name, state_at: at }) as unknown as AgentStateRow;
  it('rank, then the latest change, then the name — and it does not touch its input', () => {
    const input = [
      { rank: 2, row: r('b', '2026-10-30T01:00:00Z') }, { rank: 1, row: r('z', null) },
      { rank: 2, row: r('a', '2026-10-30T02:00:00Z') }, { rank: 2, row: r('c', '2026-10-30T02:00:00Z') },
    ];
    const copy = [...input];
    expect(sortAgentStates(input).map((x) => x.row.agent_name)).toEqual(['z', 'a', 'c', 'b']);
    expect(input).toEqual(copy);
  });
});

// story 4889 (UI-6 · W1) — which ds StatusLabel look the team list row's word wears. Pure; the words stay the strip's own table.
describe('stateMark (4889 W1)', () => {
  const none = { ask: false, limitRests: false };
  it('a person\'s hand → needs-hand: a permission · a macOS window · an input question', () => {
    for (const w of ['waiting_permission', 'waiting_system', 'waiting_input']) expect(stateMark(w, none)).toBe('needs-hand');
  });
  it('a first-screen question wins over starting / working / idle (the strip says «터미널 질문» there) — but not over a word that is already something else', () => {
    for (const w of ['starting', 'working', 'idle']) expect(stateMark(w, { ask: true, limitRests: false })).toBe('needs-hand');
    expect(stateMark('error', { ask: true, limitRests: false })).toBe('failed');
  });
  it('error → failed · working → working · starting / idle / paused_limit → idle', () => {
    expect(stateMark('error', none)).toBe('failed');
    expect(stateMark('working', none)).toBe('working');
    for (const w of ['starting', 'idle', 'paused_limit']) expect(stateMark(w, none)).toBe('idle');
  });
  it('⭐a limit the app waits out reads as resting (idle) — not as a hand, even on waiting_input / working', () => {
    expect(stateMark('waiting_input', { ask: false, limitRests: true })).toBe('idle');
    expect(stateMark('working', { ask: false, limitRests: true })).toBe('idle');
  });
  it('the computer lost · stopped · a word this page does not know → offline', () => {
    for (const w of ['unknown', 'stopped', 'unrecognized', 'something-new']) expect(stateMark(w, none)).toBe('offline');
  });
});
