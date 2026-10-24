import { describe, expect, it } from 'vitest';
import { agentsStillToWake, parseAgentWake } from './agent-wake';

describe('parseAgentWake — story #4761 (D3)', () => {
  it('keeps well-formed targets, drops the rest, and is undefined when nobody is left', () => {
    expect(parseAgentWake({ required: [{ member_id: 'a', name: 'Walk Agent' }] })).toEqual({ required: [{ member_id: 'a', name: 'Walk Agent' }] });
    expect(parseAgentWake({ required: [{ member_id: 'a', name: 'X' }, { member_id: 3, name: 'Y' }, { name: 'Z' }, null, { member_id: 'b', name: '  ' }] }))
      .toEqual({ required: [{ member_id: 'a', name: 'X' }] });
    expect(parseAgentWake({ required: [] })).toBeUndefined();
    expect(parseAgentWake({ required: 'a' })).toBeUndefined();
    expect(parseAgentWake({})).toBeUndefined();
    expect(parseAgentWake(null)).toBeUndefined();
    expect(parseAgentWake('x')).toBeUndefined();
  });
});

describe('agentsStillToWake', () => {
  const wake = { required: [{ member_id: 'a', name: 'A' }, { member_id: 'b', name: 'B' }] };
  it('every agent is still to wake while nobody has answered', () => {
    expect(agentsStillToWake(wake, [{ created_by: 'me' }])).toEqual(wake.required);
  });
  it('an agent that has said anything after the message drops out; the other stays', () => {
    expect(agentsStillToWake(wake, [{ created_by: 'me' }, { created_by: 'a' }])).toEqual([{ member_id: 'b', name: 'B' }]);
  });
  it('all answered → nothing; no wake at all → nothing', () => {
    expect(agentsStillToWake(wake, [{ created_by: 'a' }, { created_by: 'b' }])).toEqual([]);
    expect(agentsStillToWake(undefined, [])).toEqual([]);
  });
});
