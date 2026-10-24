import { describe, expect, it } from 'vitest';
import { agentsStillToWake, parseAgentWake, recalledAgentWake, rememberAgentWake } from './agent-wake';
import { sentMessageFromAnswer } from '@/hooks/use-chat-sse';

describe('parseAgentWake — story #4761 (D3)', () => {
  it('keeps well-formed targets, drops the rest, and is undefined when nobody is left', () => {
    expect(parseAgentWake({ required: [{ member_id: 'a', name: 'Walk Agent' }] })).toEqual({ required: [{ member_id: 'a', name: 'Walk Agent' }] });
    // an agent without a name still needs the sentence — it keeps its place with an empty name (the screen says «이름 없는 에이전트»)
    expect(parseAgentWake({ required: [{ member_id: 'a', name: 'X' }, { member_id: 3, name: 'Y' }, { name: 'Z' }, null, { member_id: 'b', name: '  ' }, { member_id: 'c' }] }))
      .toEqual({ required: [{ member_id: 'a', name: 'X' }, { member_id: 'b', name: '' }, { member_id: 'c', name: '' }] });
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

describe('rememberAgentWake / recalledAgentWake — a view replaced after the send (fork · re-read) still draws the line', () => {
  it('returns what was remembered for that message id and nothing for another', () => {
    const wake = { required: [{ member_id: 'a', name: 'A' }] };
    rememberAgentWake('msg-1', wake);
    expect(recalledAgentWake('msg-1')).toEqual(wake);
    expect(recalledAgentWake('msg-2')).toBeUndefined();
  });
  it('keeps at most 50 — the oldest goes first', () => {
    const w = { required: [{ member_id: 'a', name: 'A' }] };
    for (let i = 0; i < 60; i += 1) rememberAgentWake(`cap-${i}`, w);
    expect(recalledAgentWake('cap-0')).toBeUndefined();
    expect(recalledAgentWake('cap-9')).toBeUndefined();
    expect(recalledAgentWake('cap-10')).toEqual(w);
    expect(recalledAgentWake('cap-59')).toEqual(w);
  });
});

describe('sentMessageFromAnswer — the answer\'s `agent_wake` (story #4761)', () => {
  const SENT = { id: 'sent-1', sender: { id: 'me', name: '나', type: 'human' }, content: '안녕', attachments: [], created_at: '2026-10-23T23:30:16Z' };
  it('puts the wake on the message and keeps it by id for a view built later', () => {
    const msg = sentMessageFromAnswer({ data: SENT, agent_wake: { required: [{ member_id: 'ag', name: 'Walk Agent' }] } });
    expect(msg.agent_wake).toEqual({ required: [{ member_id: 'ag', name: 'Walk Agent' }] });
    expect(recalledAgentWake('sent-1')).toEqual(msg.agent_wake);
  });
  it('an answer without it leaves the message plain and remembers nothing', () => {
    const msg = sentMessageFromAnswer({ data: { ...SENT, id: 'sent-2' } });
    expect(msg.agent_wake).toBeUndefined();
    expect(recalledAgentWake('sent-2')).toBeUndefined();
  });
});
