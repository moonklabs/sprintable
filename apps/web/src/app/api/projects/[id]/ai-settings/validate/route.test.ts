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
  it('POST — 키가 유효하면 provider 호출 후 { status: "valid" } 반환', async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const resp = await POST(jsonRequest({ provider: 'openai', api_key: 'sk-live-xyz' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { status: 'valid', project_id: 'proj-1' },
      error: null,
      meta: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models');
  });

  it('POST — provider가 401/403이면 { status: "invalid" }(진짜 무효)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    const resp = await POST(jsonRequest({ provider: 'anthropic', api_key: 'sk-bad' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { status: 'invalid', project_id: 'proj-1' } });
  });

  // story #3644(3632 후속, 유나 v3.1 목록 즉시 결함) — 이 테스트는 원래 "throw하면
  // valid: false"(=invalid로 수렴)을 고정하고 있었다. 그 자체가 결함이었다 — 네트워크
  // 실패·타임아웃·DNS 오류는 "무효 확認"이 아니라 "검증하지 못함"이다(doc §1: 모름을
  // 아님으로 오독하면 사용자가 멀쩡한 키를 버리고 새로 발급하러 간다). status="unknown"
  // 으로 수정.
  it('POST — provider 호출이 throw하면 { status: "unknown" } — invalid로 수렴 금지', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const resp = await POST(jsonRequest({ provider: 'groq', api_key: 'sk-x' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { status: 'unknown' } });
  });

  it('POST — AbortSignal 타임아웃(DOMException)도 { status: "unknown" }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted', 'AbortError'); }));

    const resp = await POST(jsonRequest({ provider: 'anthropic', api_key: 'sk-ant-test' }), ctx());

    await expect(resp.json()).resolves.toMatchObject({ data: { status: 'unknown' } });
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
