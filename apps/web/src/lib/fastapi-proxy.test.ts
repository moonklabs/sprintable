// story 7d6b770b PO 승인조건 ⭐1급 게이트: X-Project-Id(project-switch override)가
// getAuthContext/getOrgProjectAuthContext 변경과 완전히 독립적으로 원본 request에서
// FastAPI로 그대로 전달되는지(스테일 JWT project_id로 덮이지 않는지) 증명.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { proxyToFastapi, proxyToFastapiWithParams } from './fastapi-proxy';

describe('fastapi-proxy — X-Project-Id override passthrough (story 7d6b770b 회귀가드)', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue({
      // JWT claim의 project_id는 'jwt-stale-proj'(과거 탭에서 발급) — 실제 요청은 다른
      // project로 override했다고 가정. 이 값이 절대 승리하면 안 된다(cross-project 오작동).
      access_token: 'token-1', org_id: 'org-1', project_id: 'jwt-stale-proj',
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it('X-Project-Id 헤더가 있으면 JWT claim project_id 무시하고 그대로 FastAPI에 전달', async () => {
    const request = new Request('http://localhost/api/retro-sessions/abc', {
      headers: { 'x-project-id': 'override-proj-live' },
    });

    await proxyToFastapi(request, '/api/v2/retros/abc');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-project-id']).toBe('override-proj-live');
    // JWT의 stale project_id 값이 어디에도 섞여 나가면 안 됨.
    expect(Object.values(headers)).not.toContain('jwt-stale-proj');
  });

  it('proxyToFastapiWithParams도 동일하게 X-Project-Id를 그대로 전달', async () => {
    const request = new Request('http://localhost/api/retro-sessions/abc', {
      headers: { 'x-project-id': 'override-proj-live' },
    });

    await proxyToFastapiWithParams(request, '/api/v2/retros/[id]', { id: 'abc' });

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/retros/abc');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-project-id']).toBe('override-proj-live');
  });

  it('X-Project-Id 헤더가 없으면 아예 안 실림(JWT project_id로 대체 주입되지 않음)', async () => {
    const request = new Request('http://localhost/api/retro-sessions/abc');

    await proxyToFastapi(request, '/api/v2/retros/abc');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-project-id']).toBeUndefined();
  });
});

// story #2190 — proxyToFastapi가 응답 헤더를 Content-Type 하나만 남기고 전부 버려서, board
// 분기(list_stories)가 X-Total-Count/X-Next-Cursor로만 내보내는 커서 페이지네이션 신호가
// 호출부(stories/backlog route)에 도달하기 前에 사라지던 결함의 회귀가드. 허용목록만 옮기고
// 절대 통째로 복사하지 않는다(Content-Length/Content-Encoding/Set-Cookie/Transfer-Encoding이
// 재구성된 응답과 어긋나거나 보안 표면이 되는 자리라 — 그래서 이 테스트가 "밖은 안 나간다"도 함께 고정한다).
describe('fastapi-proxy — 응답 헤더 allowlist forward(story #2190)', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue({ access_token: 'token-1', org_id: 'org-1', project_id: 'proj-1' });
  });

  it('X-Total-Count·X-Next-Cursor는 응답에 그대로 실려 나온다', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'x-total-count': '278', 'x-next-cursor': '2026-07-23T07:20:58.962535+00:00' },
    }));
    const request = new Request('http://localhost/api/stories/backlog?project_id=p1&status=backlog&limit=20');

    const res = await proxyToFastapi(request, '/api/v2/stories');

    expect(res.headers.get('x-total-count')).toBe('278');
    expect(res.headers.get('x-next-cursor')).toBe('2026-07-23T07:20:58.962535+00:00');
  });

  it('허용목록 밖 헤더(Set-Cookie 등)는 절대 안 나간다 — 통째로 복사가 아님을 고정', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: {
        'set-cookie': 'session=leaked; HttpOnly',
        'content-encoding': 'gzip',
        'x-internal-debug': 'should-not-leak',
      },
    }));
    const request = new Request('http://localhost/api/stories/backlog?project_id=p1');

    const res = await proxyToFastapi(request, '/api/v2/stories');

    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('x-internal-debug')).toBeNull();
  });

  it('두 헤더 다 없으면 응답 헤더도 Content-Type뿐(무회귀 — 기존 130+ 라우트 전제)', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const request = new Request('http://localhost/api/me');

    const res = await proxyToFastapi(request, '/api/v2/me');

    expect(res.headers.get('x-total-count')).toBeNull();
    expect(res.headers.get('x-next-cursor')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});
