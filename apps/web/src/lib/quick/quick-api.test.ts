import { beforeEach, describe, expect, it, vi } from 'vitest';

type Reply = { status: number; body?: unknown };
const routes: { match: (url: string, init?: RequestInit) => boolean; reply: () => Reply | Promise<Reply> | 'throw' }[] = [];
const calls: { url: string; init?: RequestInit }[] = [];

vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url, init));
    const out = r ? await r.reply() : { status: 404, body: {} };
    if (out === 'throw') throw new Error('network');
    return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body } as Response;
  }),
}));
vi.mock('@/hooks/use-chat-sse', () => ({ newClientNonce: () => 'nonce-1' }));

import { loadQuickTargets, pickDmWithAgent, pictureToFile, quickSend } from './quick-api';

const on = (match: (url: string, init?: RequestInit) => boolean, reply: () => Reply | 'throw') => routes.push({ match, reply });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
beforeEach(() => { routes.length = 0; calls.length = 0; });

describe('[SID:5047] the places a line can go', () => {
  it('the project\'s channel first (named by the project), then its agents; an internal member is no place', async () => {
    on((u) => u.startsWith('/api/current-project'), () => ({ status: 200, body: { data: { project_id: 'p1', project_name: '첫 프로젝트' } } }));
    on((u) => u.startsWith('/api/team-members'), () => ({ status: 200, body: { data: [{ id: 'a1', name: 'Dan', runtime_type: 'claude-code' }, { id: 'a2', name: '', runtime_type: 'x' }, { id: 'a3', name: 'Sys', runtime_type: 'system-publisher' }] } }));
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 200, body: { data: [{ id: 'dm1', type: 'dm' }, { id: 'ch1', type: 'group', is_project_channel: true }] } }));
    const r = await loadQuickTargets();
    expect(r.ok && r.targets.map((t) => `${t.kind}:${t.id}:${t.name}`)).toEqual(['channel:ch1:첫 프로젝트', 'agent:a1:Dan']);
  });

  it('a room list that cannot be read leaves the agents (a line to an agent still works)', async () => {
    on((u) => u.startsWith('/api/current-project'), () => ({ status: 200, body: { data: { project_id: 'p1', project_name: 'P' } } }));
    on((u) => u.startsWith('/api/team-members'), () => ({ status: 200, body: { data: [{ id: 'a1', name: 'Dan', runtime_type: 'claude-code' }] } }));
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 500 }));
    const r = await loadQuickTargets();
    expect(r.ok && r.targets.map((t) => t.kind)).toEqual(['agent']);
  });

  it('401 anywhere → «login» · other failures and a thrown request → «failed» (never an empty list that looks like «no one»)', async () => {
    on((u) => u.startsWith('/api/current-project'), () => ({ status: 401 }));
    expect(await loadQuickTargets()).toEqual({ ok: false, reason: 'login' });
    routes.length = 0;
    on((u) => u.startsWith('/api/current-project'), () => ({ status: 200, body: { data: { project_id: 'p1', project_name: 'P' } } }));
    on((u) => u.startsWith('/api/team-members'), () => ({ status: 500 }));
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 200, body: { data: [] } }));
    expect(await loadQuickTargets()).toEqual({ ok: false, reason: 'failed' });
    routes.length = 0;
    on((u) => u.startsWith('/api/current-project'), () => 'throw');
    expect(await loadQuickTargets()).toEqual({ ok: false, reason: 'failed' });
    routes.length = 0;
    on((u) => u.startsWith('/api/current-project'), () => ({ status: 200, body: { data: {} } }));
    expect(await loadQuickTargets()).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('[SID:5047] the room a line to an agent goes to', () => {
  const rows = [
    { id: 'old', type: 'dm', status: 'open', updated_at: '2026-11-01T00:00:00Z', participants: [{ member_id: 'me' }, { member_id: 'a1' }] },
    { id: 'new', type: 'dm', status: 'open', updated_at: '2026-11-02T00:00:00Z', latest_message: { created_at: '2026-11-26T00:00:00Z' }, participants: [{ member_id: 'me' }, { member_id: 'a1' }] },
    { id: 'done', type: 'dm', status: 'resolved', updated_at: '2026-11-27T00:00:00Z', participants: [{ member_id: 'me' }, { member_id: 'a1' }] },
    { id: 'other', type: 'dm', status: 'open', updated_at: '2026-11-28T00:00:00Z', participants: [{ member_id: 'me' }, { member_id: 'a2' }] },
    { id: 'grp', type: 'group', status: 'open', updated_at: '2026-11-29T00:00:00Z', participants: [{ member_id: 'a1' }] },
    { id: 'gone', type: 'dm', status: 'open', updated_at: '2026-11-30T00:00:00Z', participants: [{ member_id: 'a1', departed: true }] },
  ];
  it('the newest OPEN direct room with that agent (a resolved room, another agent\'s room, a group and a departed agent are not it)', () => {
    expect(pickDmWithAgent(rows, 'a1')).toBe('new');
    expect(pickDmWithAgent(rows, 'zzz')).toBeNull();
    expect(pickDmWithAgent('x', 'a1')).toBeNull();
  });
});

describe('[SID:5047] sending answers with the server\'s status', () => {
  const channelPost = { text: '안녕', target: { kind: 'channel' as const, id: 'ch1', name: 'P' }, picture: null };
  const isMsg = (u: string, i?: RequestInit) => u === '/api/conversations/ch1/messages' && i?.method === 'POST';

  it('a line to a channel: one POST to its messages, and the answer\'s own status comes back (201 → 201)', async () => {
    on(isMsg, () => ({ status: 201, body: {} }));
    expect(await quickSend(channelPost, 'p1')).toBe(201);
    expect(JSON.parse(calls.at(-1)!.init!.body as string)).toEqual({ content: '안녕', client_nonce: 'nonce-1' });
  });

  it.each([100, 301, 304, 401, 403, 422, 429, 500, 503])('an answer of %i comes back as it is (the app decides: not a 2xx → the window stays) — never turned into ok / not ok here', async (status) => {
    on(isMsg, () => ({ status }));
    expect(await quickSend(channelPost, 'p1')).toBe(status);
  });

  it('nothing answered (a thrown request) → null', async () => {
    on(isMsg, () => 'throw');
    expect(await quickSend(channelPost, 'p1')).toBeNull();
  });

  it('a line to an agent goes to the agent\'s existing open DM, and makes no new room', async () => {
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 200, body: { total: 1, data: [{ id: 'dm9', type: 'dm', status: 'open', participants: [{ member_id: 'a1' }] }] } }));
    on((u, i) => u === '/api/conversations/dm9/messages' && i?.method === 'POST', () => ({ status: 200, body: {} }));
    expect(await quickSend({ ...channelPost, target: { kind: 'agent', id: 'a1', name: 'Dan' } }, 'p1')).toBe(200);
    expect(calls.some((c) => c.url === '/api/conversations' && c.init?.method === 'POST')).toBe(false);
  });

  it('no DM with that agent yet → one is made (then the line is sent into it)', async () => {
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 200, body: { total: 0, data: [] } }));
    on((u, i) => u === '/api/conversations' && i?.method === 'POST', () => ({ status: 201, body: { id: 'dm-new' } }));
    on((u, i) => u === '/api/conversations/dm-new/messages' && i?.method === 'POST', () => ({ status: 201, body: {} }));
    expect(await quickSend({ ...channelPost, target: { kind: 'agent', id: 'a1', name: 'Dan' } }, 'p1')).toBe(201);
  });

  it('a room list that cannot be read makes NO room (a second room would split the talk) and the answer\'s status comes back', async () => {
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 503 }));
    expect(await quickSend({ ...channelPost, target: { kind: 'agent', id: 'a1', name: 'Dan' } }, 'p1')).toBe(503);
    expect(calls.some((c) => c.url === '/api/conversations' && c.init?.method === 'POST')).toBe(false);
  });

  it('a room list that is longer than the walk reads is NOT «no DM yet»: nothing is made (a second room would split the talk) and a failure status comes back (codex)', async () => {
    on((u) => u.startsWith('/api/conversations?'), () => ({ status: 200, body: { total: 99999, data: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, type: 'group' })) } }));
    expect(await quickSend({ ...channelPost, target: { kind: 'agent', id: 'a1', name: 'Dan' } }, 'p1')).toBe(503);
    expect(calls.some((c) => c.url === '/api/conversations' && c.init?.method === 'POST')).toBe(false);
    expect(calls.filter((c) => c.url.startsWith('/api/conversations?')).length).toBe(20);
  });

  it('the picture goes up first and rides with the message; a failed upload comes back as that status and NO message is sent', async () => {
    on((u, i) => u === '/api/conversations/ch1/attachments' && i?.method === 'POST', () => ({ status: 200, body: { url: 'https://gcs/x.png', name: 'window.png', content_type: 'image/png', size: 5 } }));
    on(isMsg, () => ({ status: 201, body: {} }));
    expect(await quickSend({ ...channelPost, picture: PNG }, 'p1')).toBe(201);
    expect(JSON.parse(calls.at(-1)!.init!.body as string).attachments).toEqual([{ url: 'https://gcs/x.png', name: 'window.png', content_type: 'image/png', size: 5 }]);

    routes.length = 0; calls.length = 0;
    on((u, i) => u === '/api/conversations/ch1/attachments' && i?.method === 'POST', () => ({ status: 413 }));
    on(isMsg, () => ({ status: 201, body: {} }));
    expect(await quickSend({ ...channelPost, picture: PNG }, 'p1')).toBe(413);
    expect(calls.some((c) => isMsg(c.url, c.init))).toBe(false);
  });

  it('a picture that cannot be read is not sent WITHOUT it (the person would think the window went along)', async () => {
    on(isMsg, () => ({ status: 201, body: {} }));
    expect(await quickSend({ ...channelPost, picture: 'data:image/png;base64,@@@' }, 'p1')).toBe(422);
    expect(calls.length).toBe(0);
  });
});

describe('[SID:5047] a captured picture as a file', () => {
  it('png and jpeg decode; anything else is refused', () => {
    const f = pictureToFile(PNG);
    expect(f?.type).toBe('image/png');
    expect(f?.name).toBe('window.png');
    expect(f?.size).toBe(8);
    expect(pictureToFile('data:image/jpeg;base64,/9j/4AAQ')?.name).toBe('window.jpg');
    expect(pictureToFile('data:image/gif;base64,AAAA')).toBeNull();
    expect(pictureToFile('https://x/y.png')).toBeNull();
  });
});
