// story #4833 — the pure parts of the Today list: what is kept from a server answer, and the rank of each word
import { describe, expect, it } from 'vitest';
import { parseAgentStates, sortAgentStates, stateRank, type AgentStateRow } from './agent-state-list';

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
