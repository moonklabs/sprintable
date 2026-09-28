// story #4299 AC2 꼬리 — /api/glance/attention 하위 구간(dev 전용 · SERVER_TIMING_MARKERS): auth → service → serialize.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));

import { GET } from './route';

const member = () => ({ id: 'm', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('/api/glance/attention GET — 하위 구간(4299)', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getOrgProjectAuthContext.mockResolvedValue(member());
    h.proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    process.env['SERVER_TIMING_MARKERS'] = 'true';
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { delete process.env['SERVER_TIMING_MARKERS']; log.mockRestore(); });

  it('헤더에 bff_auth → bff_service → bff_serialize · 본문 그대로', async () => {
    const res = await GET(new Request('http://localhost/api/glance/attention?project_id=p'));
    expect(res.headers.get('Server-Timing')).toMatch(/^bff;dur=\d+, bff_auth;dur=\d+, bff_service;dur=\d+, bff_serialize;dur=\d+$/);
    expect((await res.json()).data).toEqual({ items: [] });
  });

  it('백엔드가 실패를 돌려주면 그 응답 그대로(service · serialize 표시 없음)', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response('{}', { status: 404 }));
    const res = await GET(new Request('http://localhost/api/glance/attention?project_id=p'));
    expect(res.status).toBe(404);
    expect(res.headers.get('Server-Timing')).toMatch(/^bff;dur=\d+, bff_auth;dur=\d+$/);
  });

  it('꺼져 있으면 헤더 없음', async () => {
    delete process.env['SERVER_TIMING_MARKERS'];
    const res = await GET(new Request('http://localhost/api/glance/attention?project_id=p'));
    expect(res.headers.get('Server-Timing')).toBeNull();
  });
});
