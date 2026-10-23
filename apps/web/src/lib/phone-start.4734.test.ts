// story 4734 — the phone's start entries are one per SETUP on the wire; the screen groups the ones of one computer. Pure rules.
import { describe, expect, it } from 'vitest';
import { groupByComputer, parseStartable, type StartableComputer } from './phone-start';

const entry = (setup_id: string, over: Partial<StartableComputer> = {}): StartableComputer => ({
  setup_id, device_name: 'SYJ-MacBook-Pro', reachable: true, agents: [], ...over,
});
const agent = (id: string, over: Record<string, unknown> = {}) => ({ agent_member_id: id, name: id, can_command: true, projects: [], running: null as boolean | null, ...over });

describe('[4734] parseStartable keeps the added computer_id and nothing else changes', () => {
  it('reads computer_id when it is a non-empty string; an older server\'s entry has none', () => {
    const v = parseStartable({ remote_control: true, computers: [
      { setup_id: 's1', computer_id: 'c1', device_name: 'a', reachable: true, agents: [] },
      { setup_id: 's2', device_name: 'b', reachable: false, agents: [] },
      { setup_id: 's3', computer_id: 7, device_name: 'c', reachable: false, agents: [] },
    ] });
    expect(v?.computers.map((c) => c.computer_id)).toEqual(['c1', undefined, undefined]);
    expect(Object.keys(v!.computers[1]!).sort()).toEqual(['agents', 'device_name', 'reachable', 'setup_id']); // (the old shape, key for key)
  });
});

describe('[4734] groupByComputer', () => {
  it('entries of one computer_id become one computer: agents from all setups, each carrying its own setup_id; reachable when any is', () => {
    const grouped = groupByComputer([
      entry('s1', { computer_id: 'c1', reachable: false, agents: [agent('a1')] }),
      entry('s2', { computer_id: 'c1', reachable: true, agents: [agent('a2')] }),
      entry('s3', { computer_id: 'c2', device_name: '사무실 맥', agents: [agent('a3')] }),
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.reachable).toBe(true);
    expect(grouped[0]!.setup_id).toBe('s2'); // the reachable setup names the card
    expect(grouped[0]!.agents.map((a) => [a.agent_member_id, a.setup_id])).toEqual([['a2', 's2'], ['a1', 's1']]);
    expect(grouped[1]!.agents.map((a) => [a.agent_member_id, a.setup_id])).toEqual([['a3', 's3']]);
  });

  it('an agent listed by two setups of one computer is shown once — from the reachable setup, then the one it runs on', () => {
    const grouped = groupByComputer([
      entry('s1', { computer_id: 'c1', reachable: true, agents: [agent('a1', { running: false })] }),
      entry('s2', { computer_id: 'c1', reachable: true, agents: [agent('a1', { running: true })] }),
      entry('s3', { computer_id: 'c1', reachable: false, agents: [agent('a1', { running: true })] }),
    ]);
    expect(grouped[0]!.agents).toHaveLength(1);
    expect(grouped[0]!.agents[0]!.setup_id).toBe('s2');
  });

  it('entries without a computer_id stay one each, untouched (an older server)', () => {
    const a = entry('s1'); const b = entry('s2');
    expect(groupByComputer([a, b])).toEqual([a, b]);
  });

  it('order follows the first appearance of each computer', () => {
    const grouped = groupByComputer([entry('s1', { computer_id: 'c2' }), entry('s2', { computer_id: 'c1' }), entry('s3', { computer_id: 'c2' })]);
    expect(grouped.map((g) => g.computer_id)).toEqual(['c2', 'c1']);
  });
});
