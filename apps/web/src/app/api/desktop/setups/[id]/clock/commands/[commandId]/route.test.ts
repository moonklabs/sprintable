// story #4733 (S4b) — the press-result proxy: both ids are UUIDs, the path is exactly the contract's, no query goes on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: proxy }));
import * as route from './route';
import { GET } from './route';

const SETUP = '22222222-3333-4444-8555-666666666666';
const CMD = '33333333-4444-4555-8666-777777777777';
const params = (id: string, commandId: string) => ({ params: Promise.resolve({ id, commandId }) });

beforeEach(() => { proxy.mockReset().mockImplementation(async () => new Response('{}', { status: 200 })); });

describe('GET /api/desktop/setups/[id]/clock/commands/[commandId]', () => {
  it('exports only its HTTP handler', () => { expect(Object.keys(route)).toEqual(['GET']); });

  it('proxies to exactly /api/v2/desktop/setups/{id}/clock/commands/{command_id}, with no query', async () => {
    await GET(new Request(`http://localhost:3000/api/desktop/setups/${SETUP}/clock/commands/${CMD}?x=1`), params(SETUP, CMD));
    const [req, path] = proxy.mock.calls[0] as [Request, string];
    expect(path).toBe(`/api/v2/desktop/setups/${SETUP}/clock/commands/${CMD}`);
    expect(new URL(req.url).search).toBe('');
  });

  it('a non-UUID computer or command is a 404 and nothing is proxied', async () => {
    expect((await GET(new Request('http://localhost:3000/x'), params('nope', CMD))).status).toBe(404);
    expect((await GET(new Request('http://localhost:3000/x'), params(SETUP, '../x'))).status).toBe(404);
    expect(proxy).not.toHaveBeenCalled();
  });
});
