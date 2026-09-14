import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fastapiErr(status: number, body: unknown = { detail: 'upstream error' }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/agent-runs', () => {
  // story #3857 — BE list_agent_runs(story #3851)가 X-Total-Count·X-Next-Cursor를 내는데
  // 이 라우트가 body만 취해 버려 왔다(3844 fetch-work-list가 길이===limit 보수 휴리스틱을
  // 대신 써야 했던 원인). 이제 실제로 meta로 옮기는지 + 헤더 無일 때 하위호환을 고정한다.
  it('GET — 헤더 有(꽉 찬 페이지) → meta.hasMore=true·nextCursor·totalCount 채움', async () => {
    const runs = Array.from({ length: 50 }, (_, i) => ({ id: `run-${i}`, status: 'running' }));
    proxyToFastapi.mockResolvedValue(fastapiOk(runs, 200, {
      'x-total-count': '312',
      'x-next-cursor': '2026-09-14T08:00:00Z',
    }));

    const resp = await GET(new Request('http://test/api/agent-runs?project_id=p1&limit=50'));
    const json = await resp.json();

    expect(json.data).toHaveLength(50);
    expect(json.meta.hasMore).toBe(true);
    expect(json.meta.nextCursor).toBe('2026-09-14T08:00:00Z');
    expect(json.meta.totalCount).toBe(312);
  });

  it('GET — 헤더 無(구 BE·mock 등) → meta는 있되 hasMore=false·nextCursor/totalCount=null(하위호환, 더 있다고 단정하지 않음)', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 'run-1', status: 'running' }]));
    const request = new Request('http://test/api/agent-runs?project_id=p1');

    const resp = await GET(request);

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/agent-runs');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: [{ id: 'run-1', status: 'running' }],
      error: null,
      meta: { limit: 50, hasMore: false, nextCursor: null, totalCount: null },
    });
  });

  it('GET — 마지막 페이지(limit 미만 반환)면 헤더가 있어도 hasMore=false·nextCursor=null', async () => {
    const runs = Array.from({ length: 7 }, (_, i) => ({ id: `run-${i}` })); // limit(50) 미만
    proxyToFastapi.mockResolvedValue(fastapiOk(runs, 200, {
      'x-total-count': '7',
      'x-next-cursor': '2026-09-14T08:00:00Z', // BE가 빈 다음 페이지에도 커서를 실어도 무시
    }));

    const resp = await GET(new Request('http://test/api/agent-runs?project_id=p1&limit=50'));
    const json = await resp.json();

    expect(json.meta.hasMore).toBe(false);
    expect(json.meta.nextCursor).toBeNull();
    expect(json.meta.totalCount).toBe(7);
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, { detail: 'forbidden' }));

    const resp = await GET(new Request('http://test/api/agent-runs'));

    expect(resp.status).toBe(403);
  });

  it('POST — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ id: 'run-1', status: 'queued' }));
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ agent_id: 'a1' }) });

    const resp = await POST(request);

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/agent-runs');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { id: 'run-1', status: 'queued' },
      error: null,
      meta: null,
    });
  });

  it('POST — 204 응답은 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));

    const resp = await POST(new Request('http://test', { method: 'POST' }));

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });
});
