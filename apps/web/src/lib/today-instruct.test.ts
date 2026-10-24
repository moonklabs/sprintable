// story #4762 (AC1) — the receiver rule of the Today instruction line and its two server calls.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
const sentMessageFromAnswer = vi.fn();
vi.mock('@/hooks/use-chat-sse', () => ({ newClientNonce: () => 'nonce-1', sentMessageFromAnswer: (raw: unknown) => sentMessageFromAnswer(raw) }));

import { fetchWithAuth } from '@/lib/db/client';
import { findSoleAgentDm, sendInstruction, soleAgentDm } from './today-instruct';

const ME = 'me-1';
const dm = (id: string, others: Array<{ member_id: string; type: 'agent' | 'human' }>) => ({
  id, type: 'dm', participants: [{ member_id: ME, type: 'human' }, ...others],
});

describe('soleAgentDm — the one direct conversation with an agent', () => {
  it('exactly one agent DM → its id', () => {
    expect(soleAgentDm([dm('c1', [{ member_id: 'a1', type: 'agent' }])], ME, 1)).toBe('c1');
  });

  it('human DMs and groups do not count; one agent DM among them is still the one', () => {
    const items = [
      dm('h1', [{ member_id: 'p2', type: 'human' }]),
      { id: 'g1', type: 'group', participants: [{ member_id: ME, type: 'human' }, { member_id: 'a1', type: 'agent' }, { member_id: 'p2', type: 'human' }] },
      { id: 'g2', type: 'group', participants: [{ member_id: ME, type: 'human' }, { member_id: 'a9', type: 'agent' }] }, // a group is not a DM even with one agent in it
      dm('c1', [{ member_id: 'a1', type: 'agent' }]),
    ];
    expect(soleAgentDm(items, ME, items.length)).toBe('c1');
  });

  it('two agent DMs → null (nothing is picked for the person)', () => {
    expect(soleAgentDm([dm('c1', [{ member_id: 'a1', type: 'agent' }]), dm('c2', [{ member_id: 'a2', type: 'agent' }])], ME, 2)).toBeNull();
  });

  it('no agent DM → null', () => {
    expect(soleAgentDm([dm('h1', [{ member_id: 'p2', type: 'human' }])], ME, 1)).toBeNull();
    expect(soleAgentDm([], ME, 0)).toBeNull();
  });

  it('a page that is not the whole list → null (a second agent DM may be on a page not read)', () => {
    expect(soleAgentDm([dm('c1', [{ member_id: 'a1', type: 'agent' }])], ME, 101)).toBeNull();
    expect(soleAgentDm([dm('c1', [{ member_id: 'a1', type: 'agent' }])], ME, 1)).toBe('c1');
  });

  it('a count that is missing or not a number is «not sure» (a truncated answer must not read as the whole list)', () => {
    const one = [dm('c1', [{ member_id: 'a1', type: 'agent' }])];
    for (const bad of [undefined, null, '1', NaN]) expect(soleAgentDm(one, ME, bad)).toBeNull();
  });

  it('unreadable input → null', () => {
    for (const bad of [null, undefined, 'x', 42, {}, [null], [{ id: 1 }], [{ id: 'c', type: 'dm' }]]) expect(soleAgentDm(bad, ME, 1)).toBeNull();
    expect(soleAgentDm([dm('c1', [{ member_id: 'a1', type: 'agent' }])], '', 1)).toBeNull();
  });
});

describe('findSoleAgentDm', () => {
  afterEach(() => { vi.mocked(fetchWithAuth).mockReset(); });

  it('reads the project\'s list and returns the one agent DM', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: [dm('c1', [{ member_id: 'a1', type: 'agent' }])], total: 1 }) } as Response);
    expect(await findSoleAgentDm('p-1', ME)).toBe('c1');
    expect(vi.mocked(fetchWithAuth).mock.calls[0]![0]).toBe('/api/conversations?project_id=p-1&limit=100&offset=0');
    expect(vi.mocked(fetchWithAuth).mock.calls[0]![1]).toMatchObject({ timeoutMs: 8000 }); // a list that does not come in time is «not sure»
  });

  it('a page that is not the whole list (the server counts more than it sent) → null', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: [dm('c1', [{ member_id: 'a1', type: 'agent' }])], total: 150 }) } as Response);
    expect(await findSoleAgentDm('p-1', ME)).toBeNull();
  });

  it('a failed read or a thrown one → null (the line then does what it always did)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    expect(await findSoleAgentDm('p-1', ME)).toBeNull();
    vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network'));
    expect(await findSoleAgentDm('p-1', ME)).toBeNull();
  });
});

describe('sendInstruction', () => {
  afterEach(() => { vi.mocked(fetchWithAuth).mockReset(); sentMessageFromAnswer.mockReset(); });

  it('posts the text as the chat composer does (through fetchWithAuth), then hands the answer on (agent_wake is remembered there)', async () => {
    const answer = { data: { id: 'm1' }, agent_wake: { required: [{ member_id: 'a1', name: 'Claude Code' }] } };
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => answer } as Response);
    expect(await sendInstruction('c1', 'hello')).toBe('sent');
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chats/c1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hello', client_nonce: 'nonce-1' });
    expect((init as { timeoutMs?: number }).timeoutMs).toBe(30000); // never a button stuck for ever
    expect(sentMessageFromAnswer).toHaveBeenCalledWith(answer);
  });

  it('the server made the message but its answer cannot be read → still a success (a failure shown now would make a retry post it twice)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('bad json'); } } as unknown as Response);
    expect(await sendInstruction('c1', 'hello')).toBe('sent');
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: {} }) } as Response);
    sentMessageFromAnswer.mockImplementationOnce(() => { throw new Error('normalize'); });
    expect(await sendInstruction('c1', 'hello')).toBe('sent');
  });

  it('a refusal is `refused` (nothing was made — a retry is safe); no answer at all (network · time limit) is `unknown` (it may exist — no blind retry); neither hands anything on', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    expect(await sendInstruction('c1', 'hello')).toBe('refused');
    vi.mocked(fetchWithAuth).mockRejectedValueOnce(new Error('network'));
    expect(await sendInstruction('c1', 'hello')).toBe('unknown');
    expect(sentMessageFromAnswer).not.toHaveBeenCalled();
  });
});
