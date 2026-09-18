import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWrapped } = vi.hoisted(() => ({ proxyToFastapiWrapped: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWrapped }));

import { GET, PUT } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/gate-config/policy', () => {
  it('GET — FastAPI GET /api/v2/gate-config/policy로 위임(파라미터 없음)', async () => {
    proxyToFastapiWrapped.mockResolvedValue(fastapiOk({ data: null, error: null, meta: null }));
    const request = new Request('http://test/api/gate-config/policy');

    const resp = await GET(request);

    expect(proxyToFastapiWrapped).toHaveBeenCalledWith(request, '/api/v2/gate-config/policy');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: null, error: null, meta: null });
  });

  it('GET — 정책 미설정 시 data:null을 그대로 통과(지어내지 않음)', async () => {
    proxyToFastapiWrapped.mockResolvedValue(fastapiOk({ data: null, error: null, meta: null }));
    const resp = await GET(new Request('http://test/api/gate-config/policy'));
    await expect(resp.json()).resolves.toEqual({ data: null, error: null, meta: null });
  });

  it('PUT — FastAPI PUT /api/v2/gate-config/policy로 위임', async () => {
    proxyToFastapiWrapped.mockResolvedValue(
      fastapiOk({
        data: {
          id: 'policy-1', org_id: 'org-1', posture: 'balanced',
          merge_gate_default_approver_member_id: 'member-1',
          created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
        },
        error: null, meta: null,
      }),
    );
    const request = new Request('http://test/api/gate-config/policy', {
      method: 'PUT',
      body: JSON.stringify({ posture: 'balanced', merge_gate_default_approver_member_id: 'member-1' }),
    });

    const resp = await PUT(request);

    expect(proxyToFastapiWrapped).toHaveBeenCalledWith(request, '/api/v2/gate-config/policy');
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.data.posture).toBe('balanced');
  });

  it('PUT — 422(에이전트 멤버 지정 등)는 그대로 pass-through', async () => {
    proxyToFastapiWrapped.mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: 'merge_gate_default_approver_member_id는 이 조직의 human owner/admin 멤버여야 합니다(에이전트는 requires_human 게이트에 서명할 수 없습니다).',
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await PUT(new Request('http://test/api/gate-config/policy', { method: 'PUT', body: '{}' }));
    expect(resp.status).toBe(422);
    const body = await resp.json();
    expect(body.detail).toContain('human owner/admin');
  });

  it('PUT — 403(org admin/owner 아님)은 그대로 pass-through', async () => {
    proxyToFastapiWrapped.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org admin/owner required' }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await PUT(new Request('http://test/api/gate-config/policy', { method: 'PUT', body: '{}' }));
    expect(resp.status).toBe(403);
  });
});
