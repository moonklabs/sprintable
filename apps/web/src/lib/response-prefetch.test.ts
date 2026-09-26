import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { createResponsePrefetch } from './response-prefetch';

afterEach(() => fetchWithAuthMock.mockReset());

describe('response-prefetch(story #4328 · 4276 규칙 공용화)', () => {
  it('선출발 뒤 같은 범위 · 기한 안이면 그 응답을 한 번 넘겨주고 · 두 번째는 새 요청', async () => {
    fetchWithAuthMock.mockReturnValueOnce(Promise.resolve(new Response('1'))).mockReturnValue(Promise.resolve(new Response('2')));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    expect(await (await s.take('/a', 'k', 5_000)).text()).toBe('1');
    expect(await (await s.take('/a', 'k', 5_000)).text()).toBe('2');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('기한이 지나거나 범위가 다르면 버리고 새로 요청', () => {
    fetchWithAuthMock.mockImplementation(() => Promise.resolve(new Response('x')));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    s.take('/a', 'k', 10_001);
    s.start('/b', 'k', 0);
    s.take('/b', 'other', 1);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(4);
  });

  it('같은 범위 · 기한 안이면 다시 출발하지 않는다(여러 선출발 지점 · StrictMode)', () => {
    fetchWithAuthMock.mockImplementation(() => Promise.resolve(new Response('x')));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    s.start('/a', 'k', 100);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('⭐선출발이 실패하면 넘기지 않는다 — 화면이 제 요청을 한 번 하고 그 결과를 받는다(까디르 4694 ② · 없을 때보다 나빠지지 않게)', async () => {
    const ok = new Response('fresh', { status: 200 });
    fetchWithAuthMock.mockReturnValueOnce(Promise.resolve(new Response('boom', { status: 503 }))).mockReturnValueOnce(Promise.resolve(ok));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    const res = await s.take('/a', 'k', 1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fresh');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('선출발이 거부(네트워크 · 시간 초과)돼도 화면이 제 요청을 한 번 한다', async () => {
    fetchWithAuthMock.mockReturnValueOnce(Promise.reject(new TypeError('fetch failed'))).mockReturnValueOnce(Promise.resolve(new Response('fresh')));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    expect(await (await s.take('/a', 'k', 1)).text()).toBe('fresh');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('화면의 제 요청도 실패하면 그 실패를 그대로 받는다(다시 돌지 않는다 · 1회)', async () => {
    fetchWithAuthMock.mockReturnValueOnce(Promise.resolve(new Response('a', { status: 503 }))).mockReturnValueOnce(Promise.resolve(new Response('b', { status: 502 })));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    expect((await s.take('/a', 'k', 1)).status).toBe(502);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });
});
