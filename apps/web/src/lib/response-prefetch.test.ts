import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));

import { createResponsePrefetch } from './response-prefetch';

afterEach(() => fetchWithAuthMock.mockReset());

describe('response-prefetch(story #4328 · 4276 규칙 공용화)', () => {
  it('선출발 뒤 같은 범위 · 기한 안이면 그 응답을 한 번 넘겨주고 · 두 번째는 새 요청', () => {
    const p1 = Promise.resolve(new Response('1'));
    fetchWithAuthMock.mockReturnValueOnce(p1).mockReturnValue(Promise.resolve(new Response('2')));
    const s = createResponsePrefetch(10_000);
    s.start('/a', 'k', 0);
    expect(s.take('/a', 'k', 5_000)).toBe(p1);
    expect(s.take('/a', 'k', 5_000)).not.toBe(p1);
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
});
