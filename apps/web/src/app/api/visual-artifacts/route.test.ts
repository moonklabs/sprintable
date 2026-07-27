import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts?story_id=s1');

describe('GET /api/visual-artifacts (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the FastAPI _ok() envelope into a single envelope — the array must land directly on .data, not .data.data', async () => {
    const artifacts = [{ id: 'a1', title: 'X', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: null, created_at: '2026-07-10T00:00:00Z' }];
    proxyToFastapi.mockResolvedValue(enveloped(artifacts));
    const res = await GET(req());
    const json = await res.json() as { data: unknown };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(artifacts);
  });

  it('falls back to an empty array (not a crash) when the upstream envelope has no data field', async () => {
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ error: null, meta: null }), { status: 200 }));
    const res = await GET(req());
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual([]);
  });

  it('passes through proxy errors (e.g. 404 when BE route unavailable)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await GET(req())).status).toBe(404);
  });
});

const postReq = (body: unknown) =>
  new Request('http://localhost/api/visual-artifacts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

describe('POST /api/visual-artifacts (story 9449da0e — 캔버스 휴먼 진입점 생성 딸깍, BE _ok() unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await POST(postReq({ story_id: 's1', title: 'X', nodes: [] }))).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the FastAPI _ok() envelope — the created detail lands directly on .data, not .data.data, with 201', async () => {
    const detail = { id: 'a1', title: '제목 없는 산출물', story_id: 's1', epic_id: null, doc_id: null, source: 'created', latest_version_number: 1, anchor_version: null, created_by: 'm1', created_at: '2026-07-13T00:00:00Z', version_number: 1, version_summary: null, nodes: [] };
    proxyToFastapi.mockResolvedValue(enveloped(detail, 201));
    const res = await POST(postReq({ story_id: 's1', title: '제목 없는 산출물', nodes: [] }));
    expect(res.status).toBe(201);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(detail);
  });

  it('passes through proxy errors (e.g. 404 for a story outside the caller project)', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await POST(postReq({ story_id: 's-other-project', title: 'X', nodes: [] }))).status).toBe(404);
  });
});
