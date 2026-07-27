// @vitest-environment jsdom
//
// story #2160 — fetchWithAuth가 signalSessionExpired 이후엔 네트워크를 타지 않는지 고정한다.
// 이게 없으면 401 폴링/SSE 재연결 루프가 세션이 죽은 뒤에도 매 tick마다 refresh를 재시도해
// "401에는 재시도하지 않는다"는 처방이 무력화된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from './client';
import { resetSessionExpired, signalSessionExpired } from '@/lib/auth/session-expired-signal';

beforeEach(() => {
  resetSessionExpired();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionExpired();
});

describe('fetchWithAuth — 세션만료 신호 후 단락(#2160)', () => {
  it('signalSessionExpired 이전에는 평범하게 fetch한다', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchWithAuth('/api/me');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  it('signalSessionExpired 이후에는 fetch를 아예 타지 않고 즉시 401을 반환한다', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    signalSessionExpired();
    const res = await fetchWithAuth('/api/me');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});
