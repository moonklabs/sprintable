import { afterEach, describe, expect, it, vi } from 'vitest';

const session = vi.fn();
vi.mock('@/lib/db/server', () => ({ getServerSession: () => session() }));

import { GET } from './route';

afterEach(() => { vi.unstubAllEnvs(); session.mockReset(); });

describe('story 4824 — /api/channel/token tells the page where the backend is', () => {
  it('answers with the token and the backend origin read now (the page opens its websocket there)', async () => {
    session.mockResolvedValue({ access_token: 'tok-1' });
    vi.stubEnv('SPRINTABLE_API_ORIGIN', 'http://127.0.0.1:41234');
    const body = await (await GET()).json();
    expect(body).toEqual({ token: 'tok-1', backend_origin: 'http://127.0.0.1:41234' });
    vi.stubEnv('SPRINTABLE_API_ORIGIN', 'http://127.0.0.1:52999');
    expect((await (await GET()).json()).backend_origin).toBe('http://127.0.0.1:52999');
  });

  it('hosted (no SPRINTABLE_API_ORIGIN): the page gets the same address it used to bake in — the build value, or the local default', async () => {
    session.mockResolvedValue({ access_token: 'tok-1' });
    vi.stubEnv('SPRINTABLE_API_ORIGIN', '');
    vi.stubEnv('NEXT_PUBLIC_FASTAPI_URL', 'https://dev-api.sprintable.ai');
    expect((await (await GET()).json()).backend_origin).toBe('https://dev-api.sprintable.ai');
    vi.stubEnv('NEXT_PUBLIC_FASTAPI_URL', '');
    expect((await (await GET()).json()).backend_origin).toBe('http://localhost:8000');
  });

  it('no session is still 401, with no origin in the answer', async () => {
    session.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('127.0.0.1');
  });
});
