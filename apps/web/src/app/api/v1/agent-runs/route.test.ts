import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b3): proxy 위임 리팩토링 후 stale 테스트 재작성 — pure proxy(인증 게이트 없음).
const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

const PATH = '/api/v2/agent-runs';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = (m = 'GET') => new Request('http://localhost/x', { method: m });

describe('/api/v1/agent-runs (proxy 위임)', () => {
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

  // agent-runs-list.tsx의 「더 보기」가 라이브에서 구조적으로 죽어 있던 원인(2026-07-27
  // 발견, #2230/#2231과 동형) — BE가 규약 A({data,meta})를 내는데 apiSuccess(json)에
  // 통째로 넘기면 바깥 data에 BE 전체가 다시 얹히고 바깥 meta는 항상 null이 된다.
  it('GET: BE의 {data,meta}(규약 A) 응답을 이중포장하지 않고 풀어서 넘긴다', async () => {
    proxyToFastapi.mockResolvedValue(okRes({
      data: [{ id: 'run-1' }, { id: 'run-2' }],
      error: null,
      meta: { hasMore: true, nextCursor: 'run-2' },
    }));
    const res = await GET(req('GET'));
    const json = await res.json();

    // ⛔양성대조 — 고치기 전엔 이 assertion들이 실패했다(json.data가 BE 전체 {data,error,meta}
    // 봉투 그 자체였고, json.meta는 항상 null이었다). 직접 재현: 이 파일 fix 전 커밋에서 실행하면 RED.
    expect(json.data).toEqual([{ id: 'run-1' }, { id: 'run-2' }]);
    expect(json.meta).toEqual({ hasMore: true, nextCursor: 'run-2' });
  });

  it('POST: 단건 생성 응답도 이중포장하지 않는다(data.data 금지)', async () => {
    proxyToFastapi.mockResolvedValue(okRes({ data: { id: 'run-new' }, error: null, meta: null }));
    const res = await POST(req('POST'));
    const json = await res.json();
    expect(json.data).toEqual({ id: 'run-new' });
  });
});
