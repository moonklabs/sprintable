import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));

import { POST } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('POST /api/retro-sessions/[id]/actions', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
    vi.restoreAllMocks();
  });

  it('returns 400 when project_id is missing', async () => {
    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/actions', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: JSON.stringify({ title: 'Follow up' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(400);
  });

  // B3(9f27af8f): 라우트가 검증용으로 request.json()을 먼저 읽은 뒤 proxy가 request.text()를 다시 호출하면
  // "Body is unusable: Body has already been read" TypeError로 항상 실패하던 회귀 — 실제 fetch까지 도달해
  // title/assignee_id 페이로드가 FastAPI로 온전히 전달되는지 (fastapi-proxy를 모킹하지 않고) 확인한다.
  it('forwards the full body (title + assignee_id) to FastAPI without consuming it twice', async () => {
    const created = { id: 'action-1', session_id: 'session-1', title: 'Follow up', assignee_id: 'member-1', status: 'open' };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await POST(
      new Request('http://localhost/api/retro-sessions/session-1/actions?project_id=project-1', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: JSON.stringify({ title: 'Follow up', assignee_id: 'member-1' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.assignee_id).toBe('member-1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const forwardedBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(forwardedBody).toEqual({ title: 'Follow up', assignee_id: 'member-1' });
  });
});
