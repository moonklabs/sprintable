import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { PUT } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/connectors/[key]/config', () => {
  it('PUT — FastAPI PUT /api/v2/organizations/[id]/connectors/[key]/config로 위임', async () => {
    const updated = { connector_key: 'stibee', version: '1.0.0', channel: 'stibee', fields: [], requires_env: [], kinds: ['publish'], org_config: { 'create.senderEmail': 'a@b.com' } };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(updated));

    const request = new Request('http://test/api/organizations/org-1/connectors/stibee/config', {
      method: 'PUT',
      body: JSON.stringify({ config: { 'create.senderEmail': 'a@b.com' } }),
    });
    const resp = await PUT(request, { params: Promise.resolve({ id: 'org-1', key: 'stibee' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/connectors/[key]/config', { id: 'org-1', key: 'stibee' },
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.data.org_config).toEqual({ 'create.senderEmail': 'a@b.com' });
  });

  it('PUT — 422(미선언 키·타입불일치)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'unknown config key' }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PUT(
      new Request('http://test', { method: 'PUT', body: '{}' }),
      { params: Promise.resolve({ id: 'org-1', key: 'stibee' }) },
    );
    expect(resp.status).toBe(422);
  });

  it('PUT — 403(org owner/admin 아님)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org owner/admin required to set connector config' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PUT(
      new Request('http://test', { method: 'PUT', body: '{}' }),
      { params: Promise.resolve({ id: 'org-1', key: 'stibee' }) },
    );
    expect(resp.status).toBe(403);
  });

  it('PUT — 404(스키마 미등록)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'connector not registered' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PUT(
      new Request('http://test', { method: 'PUT', body: '{}' }),
      { params: Promise.resolve({ id: 'org-1', key: 'unknown' }) },
    );
    expect(resp.status).toBe(404);
  });
});
