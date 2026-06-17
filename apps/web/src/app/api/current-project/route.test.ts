import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b10): cookies + dynamic import(fastapiCall·getServerSession) 핸들러.
// GET=게이트+프로젝트명 조회(실패 fallback) / POST=게이트 없음·parseBody→쿠키 set→프로젝트명.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), fastapiCall: vi.fn(), getServerSession: vi.fn(),
  cookieSet: vi.fn(), parseBody: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext, CURRENT_PROJECT_COOKIE: 'sp_cur_proj' }));
vi.mock('@sprintable/storage-api', () => ({ fastapiCall: h.fastapiCall }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.getServerSession }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ set: h.cookieSet })) }));
vi.mock('@sprintable/shared', async (importActual) => ({
  ...(await importActual<typeof import('@sprintable/shared')>()),
  parseBody: h.parseBody,
}));

import { GET, POST } from './route';

const me = () => ({ id: 'a', type: 'human', org_id: 'org-1', project_id: 'p1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('/api/current-project (cookies + dynamic import)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(me());
    h.getServerSession.mockResolvedValue({ access_token: 'tok' });
    h.fastapiCall.mockResolvedValue({ name: 'Alpha', id: 'p1' });
  });

  it('GET: 401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/current-project'))).status).toBe(401);
  });
  it('GET: returns project_id/org_id + name from fastapiCall', async () => {
    const res = await GET(new Request('http://localhost/api/current-project'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ project_id: 'p1', org_id: 'org-1', project_name: 'Alpha' });
  });
  it('GET: fastapiCall 실패해도 200 + 기본 이름(fallback)', async () => {
    h.fastapiCall.mockRejectedValue(new Error('be down'));
    const res = await GET(new Request('http://localhost/api/current-project'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ project_id: 'p1', project_name: 'My Project' });
  });

  it('POST: invalid body → parseBody 400', async () => {
    h.parseBody.mockResolvedValue({ success: false, response: new Response('bad', { status: 400 }) });
    expect((await POST(new Request('http://localhost/api/current-project', { method: 'POST', body: '{}' }))).status).toBe(400);
    expect(h.cookieSet).not.toHaveBeenCalled();
  });
  it('POST: valid → 쿠키 set + 200 + project_id', async () => {
    h.parseBody.mockResolvedValue({ success: true, data: { project_id: 'p2' } });
    const res = await POST(new Request('http://localhost/api/current-project', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(200);
    expect(h.cookieSet).toHaveBeenCalledWith('sp_cur_proj', 'p2', expect.objectContaining({ path: '/' }));
    expect((await res.json()).data).toMatchObject({ project_id: 'p2' });
  });
});
