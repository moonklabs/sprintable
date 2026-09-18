import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #3857 — GET은 예전엔 ApiSprintRepository(fastapiCall, 헤더 버림)를 거쳤는데, BE
// list_sprints(#2428 PR④)가 내는 X-Total-Count·X-Next-Cursor에 도달할 길이 없었다.
// goals/route.ts positionMode·stories/backlog/route.ts(#2190)와 동형으로 proxyToFastapi
// 직행으로 바꿨다 — POST는 그대로 repo/service 경로(create만 쓰므로 헤더 무관).
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  createSprintRepository: vi.fn(),
  create: vi.fn(),
  proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createSprintRepository: h.createSprintRepository }));
vi.mock('@/services/sprint', async (importActual) => ({
  ...(await importActual<typeof import('@/services/sprint')>()),
  SprintService: class { create = h.create; },
}));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));

import { GET, POST } from './route';

const agent = () => ({ id: 'a', type: 'agent', project_id: 'p1', org_id: 'o1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

function fastapiOk(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('/api/sprints', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createSprintRepository.mockResolvedValue({});
  });

  describe('GET — 페이지네이션 meta(story #3857)', () => {
    it('직행 프록시로 나간다(repo/service 우회) — 쿼리스트링 그대로 forward', async () => {
      h.proxyToFastapi.mockResolvedValue(fastapiOk([]));
      const request = new Request('http://localhost/api/sprints?project_id=p1&status=active&limit=50&cursor=2026-09-01T00:00:00Z');

      await GET(request);

      expect(h.proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/sprints');
      expect(h.createSprintRepository).not.toHaveBeenCalled();
    });

    it('헤더 有(꽉 찬 페이지) → meta.hasMore=true·nextCursor·totalCount 채움', async () => {
      const sprints = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}` }));
      h.proxyToFastapi.mockResolvedValue(fastapiOk(sprints, { 'x-total-count': '1500', 'x-next-cursor': '2026-08-01T00:00:00Z' }));

      const res = await GET(new Request('http://localhost/api/sprints?project_id=p1&limit=1000'));
      const json = await res.json();

      expect(json.data).toHaveLength(1000);
      expect(json.meta.hasMore).toBe(true);
      expect(json.meta.nextCursor).toBe('2026-08-01T00:00:00Z');
      expect(json.meta.totalCount).toBe(1500);
    });

    it('헤더 無(하위호환) → meta.hasMore=false·nextCursor/totalCount=null(더 있다고 단정하지 않음)', async () => {
      h.proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 's1' }]));

      const res = await GET(new Request('http://localhost/api/sprints?project_id=p1'));
      const json = await res.json();

      expect(json.meta).toEqual({ limit: 1000, hasMore: false, nextCursor: null, totalCount: null });
    });

    it('!ok 응답은 그대로 pass-through', async () => {
      h.proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ detail: 'forbidden' }), { status: 403 }));

      const res = await GET(new Request('http://localhost/api/sprints?project_id=p1'));

      expect(res.status).toBe(403);
    });

    it('401 when unauthenticated', async () => {
      h.getAuthContext.mockResolvedValue(null);

      const res = await GET(new Request('http://localhost/api/sprints?project_id=p1'));

      expect(res.status).toBe(401);
      expect(h.proxyToFastapi).not.toHaveBeenCalled();
    });
  });

  describe('POST — 생성(repo/service 경로, 무변경)', () => {
    it('유효 body면 201로 생성', async () => {
      h.create.mockResolvedValue({ id: 's1', title: 'Sprint 1', project_id: 'p1', org_id: 'o1' });
      const request = new Request('http://localhost/api/sprints', {
        method: 'POST',
        body: JSON.stringify({ title: 'Sprint 1', project_id: 'p1', start_date: '2026-09-14', end_date: '2026-09-28' }),
      });

      const res = await POST(request);

      expect(res.status).toBe(201);
      await expect(res.json()).resolves.toMatchObject({ data: { id: 's1' } });
    });

    it('401 when unauthenticated', async () => {
      h.getAuthContext.mockResolvedValue(null);
      const request = new Request('http://localhost/api/sprints', { method: 'POST', body: JSON.stringify({}) });

      const res = await POST(request);

      expect(res.status).toBe(401);
    });
  });
});
