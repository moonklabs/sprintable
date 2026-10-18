// story 4711 AC4 — POST /api/invites/mine/{invite_id}/accept: the call makes a membership, so a request from another page must not make it.
// Origin is REQUIRED (none at all is refused — the shared check lets «no Origin and no Referer» through), it must be ours, and only then the id goes on to the BE route.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ proxy: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxy }));

import * as route from './route';

const ID = '11111111-1111-4111-8111-111111111111';
const post = (headers: Record<string, string>) => new Request(`http://localhost:3000/api/invites/mine/${ID}/accept`, { method: 'POST', headers });
const params = (id = ID) => ({ params: Promise.resolve({ inviteId: id }) });

beforeEach(() => { h.proxy.mockReset().mockResolvedValue(new Response('{"ok":true}', { status: 200 })); });

describe('POST /api/invites/mine/[inviteId]/accept', () => {
  it('our own origin: the id goes to the BE by-id route, once', async () => {
    const res = await route.POST(post({ Origin: 'http://localhost:3000' }), params());
    expect(res.status).toBe(200);
    expect(h.proxy).toHaveBeenCalledTimes(1);
    expect(h.proxy.mock.calls[0]![1]).toBe(`/api/v2/invites/mine/${ID}/accept`);
  });

  it('no Origin at all (not even a Referer) is refused and the BE is never called', async () => {
    const res = await route.POST(post({}), params());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('CSRF_FORBIDDEN');
    expect(h.proxy).not.toHaveBeenCalled();
  });

  it('another site\'s Origin is refused and the BE is never called', async () => {
    const res = await route.POST(post({ Origin: 'https://evil.example' }), params());
    expect(res.status).toBe(403);
    expect(h.proxy).not.toHaveBeenCalled();
  });

  it('an id that is not a UUID (a literal `..`, a path, junk) is a 404 with the BE\'s own body and the BE is never called', async () => {
    for (const id of ['..', '../../auth/me', 'not-a-uuid', '', ID + '/x']) {
      const res = await route.POST(post({ Origin: 'http://localhost:3000' }), params(id));
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Invite not found' });
    }
    expect(h.proxy).not.toHaveBeenCalled();
  });
});
