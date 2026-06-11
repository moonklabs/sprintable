import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const ctx = (id = 'proj-1') => ({ params: Promise.resolve({ id }) });

function jsonRequest(body: unknown) {
  return new Request('http://test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/api/projects/[id]/ai-settings/validate', () => {
  it('POST — 키가 유효하면 provider 호출 후 { valid: true } 반환', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resp = await POST(jsonRequest({ provider: 'openai', api_key: 'sk-live-xyz' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { valid: true, project_id: 'proj-1' },
      error: null,
      meta: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models');
  });

  it('POST — provider가 401/403이면 { valid: false }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    const resp = await POST(jsonRequest({ provider: 'anthropic', api_key: 'sk-bad' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { valid: false, project_id: 'proj-1' } });
  });

  it('POST — provider 호출이 throw하면 { valid: false }로 흡수', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const resp = await POST(jsonRequest({ provider: 'groq', api_key: 'sk-x' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { valid: false } });
  });

  it('POST — api_key 누락이면 400 BAD_REQUEST (provider 미호출)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const resp = await POST(jsonRequest({ provider: 'openai' }), ctx());

    expect(resp.status).toBe(400);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: 'BAD_REQUEST' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST — openai-compatible인데 base_url 없으면 400', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const resp = await POST(jsonRequest({ provider: 'openai-compatible', api_key: 'sk-x' }), ctx());

    expect(resp.status).toBe(400);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });
});
