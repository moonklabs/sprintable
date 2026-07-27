import { beforeEach, describe, expect, it, vi } from 'vitest';

// story: 앱 push register가 /api/v2/push/devices 직접 POST(Bearer 미첨부)해 401 —
// 웹 인증 API 관례(/api/<resource> BFF → proxyToFastapi → 백엔드)에 맞춰 신설.
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const PATH = '/api/v2/push/devices';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request('http://localhost/x', { method: m });

describe('/api/push/devices (proxy 위임)', () => {
  beforeEach(() => proxyToFastapi.mockReset());
  for (const [name, fn] of [['GET', GET], ['POST', POST]] as const) {
    it(`${name}: delegates to ${PATH} and wraps`, async () => {
      proxyToFastapi.mockResolvedValue(okRes());
      const res = await fn(req(name));
      expect(res.status).toBe(200);
      expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
      expect((await res.json()).data).toMatchObject({ ok: 1 });
    });
    it(`${name}: passes through proxy errors`, async () => {
      proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
      expect((await fn(req(name))).status).toBe(500);
    });
  }
});
