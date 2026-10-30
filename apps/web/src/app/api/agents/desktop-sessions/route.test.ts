// story #4833 — the Today list's proxy: the rows in the standard envelope, the server's total carried into meta.totalCount (never dropped), an upstream
// refusal passed through as it is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => { vi.unstubAllGlobals(); });

const req = () => new Request('http://localhost/api/agents/desktop-sessions', { headers: { Authorization: 'Bearer tok' } });
const upstream = (body: unknown, init: ResponseInit = {}) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }, ...init,
})));

describe('GET /api/agents/desktop-sessions', () => {
  it('asks the server\'s list URL and answers the rows in `data` with the total in meta.totalCount', async () => {
    upstream([{ agent_id: 'a', agent_name: 'A' }, { agent_id: 'b', agent_name: 'B' }], { headers: { 'x-total-count': '137' } });
    const res = await GET(req());
    const json = await res.json();
    expect(String((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('/api/v2/agents/desktop-sessions');
    expect(json.data.map((r: { agent_id: string }) => r.agent_id)).toEqual(['a', 'b']);
    expect(json.meta.totalCount).toBe(137);
  });

  it('no total header → totalCount null («모른다» is said, not guessed as the row count)', async () => {
    upstream([{ agent_id: 'a', agent_name: 'A' }]);
    const json = await (await GET(req())).json();
    expect(json.meta.totalCount).toBeNull();
  });

  it('an upstream refusal is passed through with its status (no envelope over an error)', async () => {
    upstream({ error: { code: 'person_session_required' } }, { status: 403 });
    const res = await GET(req());
    expect(res.status).toBe(403);
  });
});
