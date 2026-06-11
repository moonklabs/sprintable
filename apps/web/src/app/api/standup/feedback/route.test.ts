import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b2): proxy 위임 리팩토링 후 stale 테스트 재작성. feedback은 auth 게이트 없이
// 위임(GET) / POST는 standup_entry_id를 path로 들어 /standups/{id}/feedback 위임.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

describe('/api/standup/feedback (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());

  it('GET: delegates to /api/v2/standups/feedback and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(new Request('http://localhost/api/standup/feedback?entry_id=e1'));
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/standups/feedback');
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });

  it('POST: 400 when standup_entry_id missing', async () => {
    const res = await POST(new Request('http://localhost/api/standup/feedback', {
      method: 'POST', body: JSON.stringify({ rating: 5 }),
    }));
    expect(res.status).toBe(400);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('POST: delegates to /api/v2/standups/{id}/feedback when entry id present', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await POST(new Request('http://localhost/api/standup/feedback', {
      method: 'POST', body: JSON.stringify({ standup_entry_id: 'se1', rating: 5 }),
    }));
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/standups/se1/feedback');
  });
});
