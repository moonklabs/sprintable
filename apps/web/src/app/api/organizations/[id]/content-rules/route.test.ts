import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, PUT } from './route';

describe('/api/organizations/[id]/content-rules (story #3472)', () => {
  it('GET — FastAPI 콘텐츠 규칙 조회 엔드포인트로 id를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ org_id: 'org-1', rules: { banned_terms: [] }, version: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'GET' });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/content-rules', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('PUT — FastAPI PUT으로 id·body를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ org_id: 'org-1', rules: { banned_terms: ['금지어'] }, version: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', {
      method: 'PUT',
      body: JSON.stringify({ rules: { banned_terms: ['금지어'] } }),
    });
    const resp = await PUT(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/content-rules', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
  });

  // story #3436 묶음11(페드루 PO 지적, 2026-09-06) — story #3490이 PUT 권한을
  // owner 단독에서 owner-or-admin으로 넓히며 코드도 CONTENT_RULES_ADMIN_ONLY로
  // 바뀌었다(backend/tests/test_3471_org_content_rules_lint.py가 옛 owner
  // 전용 코드명 부재를 직접 검산). 이 테스트만 옛 코드명 그대로 남아 있었다 —
  // 라우트는 pass-through(검증 로직 0)라 실동작 회귀는 아니지만 다음 사람이
  // 이 테스트 이름으로 실 계약값을 오인한다.
  it('PUT — BE의 CHANNEL_CONNECTION류와 동형인 403 CONTENT_RULES_ADMIN_ONLY도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CONTENT_RULES_ADMIN_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await PUT(new Request('http://test', { method: 'PUT' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('PUT — BE의 422 CONTENT_RULES_INVALID도 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CONTENT_RULES_INVALID' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await PUT(new Request('http://test', { method: 'PUT' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
