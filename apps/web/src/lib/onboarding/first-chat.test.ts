/** story 5036 (C6 · step ③ — the web and the Mac app both): the first conversation is the PROJECT'S CHANNEL; when it cannot be found the DM with the agent (the way before channels) is kept. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { ok: boolean; body?: unknown };
const routes = new Map<string, () => Reply | Promise<Reply>>();
const calls: { url: string; method: string; body: unknown }[] = [];

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.split('?')[0]}`;
    const h = routes.get(key);
    const r = h ? await h() : { ok: false };
    return { ok: r.ok, status: r.ok ? 200 : 500, json: async () => r.body } as Response;
  }),
}));

import { findProjectChannelId, openFirstChatRoom } from './first-chat';

beforeEach(() => { routes.clear(); calls.length = 0; });

const rooms = (data: unknown) => () => ({ ok: true, body: { data } });

describe('the project\'s channel', () => {
  it('is the room the server marks `is_project_channel` — read from the project\'s own list', async () => {
    routes.set('GET /api/conversations', rooms([{ id: 'dm-1', is_project_channel: false }, { id: 'chan-1', is_project_channel: true }, { id: 'dm-2' }]));
    expect(await findProjectChannelId('proj-1')).toBe('chan-1');
    expect(calls[0]!.url).toContain('project_id=proj-1');
  });

  it.each([
    ['no room is a channel', rooms([{ id: 'dm-1', is_project_channel: false }])],
    ['the list is empty', rooms([])],
    ['the answer is not a list', () => ({ ok: true, body: { data: { id: 'x' } } })],
    ['the read failed', () => ({ ok: false })],
    ['a row with no id is not a room', rooms([{ is_project_channel: true }, { id: '', is_project_channel: true }])],
  ] as const)('%s → none (never a guess)', async (_n, reply) => {
    routes.set('GET /api/conversations', reply);
    expect(await findProjectChannelId('proj-1')).toBeNull();
  });
});

describe('the channel is read ONCE, from the project\'s own rooms (PO 11-26 — no page walk)', () => {
  it('one request: the project\'s id and nothing else in the query', async () => {
    routes.set('GET /api/conversations', rooms([{ id: 'chan-1', is_project_channel: true }]));
    expect(await findProjectChannelId('proj-1')).toBe('chan-1');
    const reads = calls.filter((c) => c.url.startsWith('/api/conversations'));
    expect(reads.length).toBe(1);
    expect(reads[0]!.url).toBe('/api/conversations?project_id=proj-1'); // reverted (a page walk / extra filters) → another URL or more reads
  });

  it('no channel in the answer → none, and no second read is made to look further', async () => {
    routes.set('GET /api/conversations', rooms(Array.from({ length: 50 }, (_x, i) => ({ id: `dm-${i}`, is_project_channel: false }))));
    expect(await findProjectChannelId('proj-1')).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('/api/conversations')).length).toBe(1);
  });
});

describe('the room the first conversation opens', () => {
  it('the channel when there is one — and no DM is made', async () => {
    routes.set('GET /api/conversations', rooms([{ id: 'chan-1', is_project_channel: true }]));
    expect(await openFirstChatRoom('proj-1', 'agent-9')).toBe('chan-1');
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // reverted (the DM is always made) → red
  });

  it('no channel found → the DM with that agent in that project, as before channels', async () => {
    routes.set('GET /api/conversations', () => ({ ok: false }));
    routes.set('POST /api/conversations', () => ({ ok: true, body: { id: 'dm-9' } }));
    expect(await openFirstChatRoom('proj-1', 'agent-9')).toBe('dm-9');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ type: 'dm', participant_ids: ['agent-9'], project_id: 'proj-1' });
  });

  it('neither can be opened → null (the page\'s own way out answers)', async () => {
    routes.set('GET /api/conversations', () => ({ ok: false }));
    routes.set('POST /api/conversations', () => ({ ok: false }));
    expect(await openFirstChatRoom('proj-1', 'agent-9')).toBeNull();
  });
});
