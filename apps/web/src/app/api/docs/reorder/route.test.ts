import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #4353 — 얇은 프록시: 인증 · 속도 제한만 여기서, 판정(409 · 404 · 번호)은 서버 응답 그대로.
const h = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));

import { POST } from './route';

const req = () => new Request('https://app.example.com/api/docs/reorder', { method: 'POST', body: JSON.stringify({ doc_id: 'd1', parent_id: null }) });

describe('POST /api/docs/reorder', () => {
  beforeEach(() => { h.getOrgProjectAuthContext.mockReset(); h.proxyToFastapi.mockReset(); });

  it('⭐인증되면 백엔드 `/api/v2/docs/reorder`로 그대로 넘기고 응답(409 포함)을 그대로 돌려준다', async () => {
    h.getOrgProjectAuthContext.mockResolvedValue({ rateLimitExceeded: false });
    const conflict = new Response(JSON.stringify({ error: { code: 'DOC_REORDER_ANCHOR_NOT_SIBLING' } }), { status: 409 });
    h.proxyToFastapi.mockResolvedValue(conflict);
    const res = await POST(req());
    expect(h.proxyToFastapi).toHaveBeenCalledWith(expect.any(Request), '/api/v2/docs/reorder');
    expect(res.status).toBe(409);
  });

  it('⭐성공: 백엔드 실제 모양(봉투 없는 {doc, siblings})을 화면이 읽는 {data: {doc, siblings}}로 감싼다', async () => {
    h.getOrgProjectAuthContext.mockResolvedValue({ rateLimitExceeded: false });
    const beBody = { doc: { id: 'd1', parent_id: null, sort_order: 0 }, siblings: [{ id: 'd1', sort_order: 0 }, { id: 'd2', sort_order: 1 }] };
    h.proxyToFastapi.mockResolvedValue(new Response(JSON.stringify(beBody), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual(beBody);
  });

  it('인증이 없으면 백엔드를 부르지 않고 401', async () => {
    h.getOrgProjectAuthContext.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(h.proxyToFastapi).not.toHaveBeenCalled();
  });
});
