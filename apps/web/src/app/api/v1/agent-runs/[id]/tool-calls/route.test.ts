import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #3722(Trust·PR2) — [id]/route.test.ts와 동형 harness. 이 자리는 X-Total-Count를
// meta.totalCount로 얹는 것까지가 계약(list_agent_runs route.ts의 "bare list 부채"를
// 반복하지 않는다).
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const ID = 'run-1';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const req = () => new Request(`http://localhost/x/${ID}/tool-calls`, { method: 'GET' });
const okRes = (body: unknown, totalCount?: string) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(totalCount !== undefined ? { 'x-total-count': totalCount } : {}),
    },
  });

describe('/api/v1/agent-runs/[id]/tool-calls (proxy 위임 + X-Total-Count 전달)', () => {
  beforeEach(() => proxyToFastapi.mockReset());

  it('delegates to /api/v2/agent-runs/{id}/tool-calls and wraps rows', async () => {
    const rows = [{ id: 'tc-1', tool: 'sprintable_add_task' }];
    proxyToFastapi.mockResolvedValue(okRes(rows, '3'));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), `/api/v2/agent-runs/${ID}/tool-calls`);
    const json = await res.json();
    expect(json.data).toEqual(rows);
    expect(json.meta.totalCount).toBe(3);
  });

  it('⭐X-Total-Count 헤더 없으면 totalCount는 null(0으로 위장하지 않는다)', async () => {
    proxyToFastapi.mockResolvedValue(okRes([]));
    const json = await (await GET(req(), ctx())).json();
    expect(json.meta.totalCount).toBeNull();
  });

  it('⭐X-Total-Count가 숫자가 아니면(계약 위반) NaN이 아니라 null(NaN===null 함정 재발 방지)', async () => {
    proxyToFastapi.mockResolvedValue(okRes([], 'not-a-number'));
    const json = await (await GET(req(), ctx())).json();
    expect(json.meta.totalCount).toBeNull();
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 404 }));
    expect((await GET(req(), ctx())).status).toBe(404);
  });
});
