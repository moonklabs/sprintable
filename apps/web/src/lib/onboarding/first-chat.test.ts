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

describe('a project with many rooms: the channel is looked for through the pages, not guessed from the first (codex 5036)', () => {
  const dms = (n: number, from = 0) => Array.from({ length: n }, (_x, i) => ({ id: `dm-${from + i}`, is_project_channel: false }));
  it('not on the first page of 50 → found on the second', async () => {
    const seen: string[] = [];
    routes.set('GET /api/conversations', () => { const url = calls.at(-1)!.url; seen.push(url); return url.includes('offset=0') ? { ok: true, body: { data: dms(50) } } : { ok: true, body: { data: [...dms(3, 50), { id: 'chan-late', is_project_channel: true }] } }; });
    expect(await findProjectChannelId('proj-1')).toBe('chan-late'); // reverted (only the first page is read) → null
    expect(seen.length).toBe(2);
    expect(seen[1]).toContain('offset=50');
  });

  it('a short page is the last: no more pages are read', async () => {
    let reads = 0;
    routes.set('GET /api/conversations', () => { reads += 1; return { ok: true, body: { data: dms(7) } }; });
    expect(await findProjectChannelId('proj-1')).toBeNull();
    expect(reads).toBe(1);
  });

  it('a page that cannot be read ends the search as «not found» (the DM way is kept)', async () => {
    routes.set('GET /api/conversations', () => { const url = calls.at(-1)!.url; return url.includes('offset=0') ? { ok: true, body: { data: dms(50) } } : { ok: false }; });
    expect(await findProjectChannelId('proj-1')).toBeNull();
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
