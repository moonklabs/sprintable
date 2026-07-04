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
