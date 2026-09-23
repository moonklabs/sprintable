// @vitest-environment jsdom
//
// story #4184 — fetchMe() 결과 재사용의 무효화 신호가 «캐시가 낡을 수 있는 순간»마다 실제로 나가는지(자리별 핀).
// me-client는 이 신호만 믿고 재사용하므로, 한 자리라도 빠지면 곧 낡은 `/api/me`(까디르 QA ① 무효화 누락 · ② 만료 뒤 200).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMeInvalidated } from './me-invalidation';
import { fetchWithAuth, loginWithPassword, logoutUser, refreshAuthTokens } from '@/lib/db/client';
import { resetSessionExpired, signalSessionExpired } from './session-expired-signal';

let calls = 0;
let off: () => void;

beforeEach(() => {
  calls = 0;
  off = onMeInvalidated(() => { calls += 1; });
  resetSessionExpired();
});

afterEach(() => {
  off();
  vi.unstubAllGlobals();
  resetSessionExpired();
});

const ok = () => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('/api/me 결과 재사용 무효화 신호(story #4184)', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('fetchWithAuth 쓰기 요청(%s) → 무효화', async (method) => {
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    await fetchWithAuth('/api/me', { method });
    expect(calls).toBe(1);
  });

  it('Request 객체로 온 쓰기도 무효화', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    await fetchWithAuth(new Request('http://localhost/api/x', { method: 'POST' }));
    expect(calls).toBe(1);
  });

  it('음성대조 — GET·HEAD는 무효화하지 않는다(재사용이 살아 있어야 한다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok()));
    await fetchWithAuth('/api/x');
    await fetchWithAuth('/api/x', { method: 'HEAD' });
    expect(calls).toBe(0);
  });

  // 401 자리엔 따로 두지 않는다 — 401은 늘 토큰 갱신으로 이어지고, 두 결과 모두 무효화한다(만료 뒤 캐시된 200 금지).
  it('fetchWithAuth 401 → 갱신 실패(세션 만료 신호) → 무효화', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/refresh')) return new Response(JSON.stringify({ error: { code: 'X', message: 'x' } }), { status: 401 });
      return new Response(null, { status: 401 });
    }));
    await fetchWithAuth('/api/x');
    expect(calls).toBe(1);
  });

  it('fetchWithAuth 401 → 갱신 성공 → 무효화(새 토큰의 주체로 다시 묻게)', async () => {
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/refresh')) return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      if (first) { first = false; return new Response(null, { status: 401 }); }
      return ok();
    }));
    const res = await fetchWithAuth('/api/x');
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('로그인 성공 → 무효화', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { access_token: 'a', refresh_token: 'r', token_type: 'bearer' } }), { status: 200 })));
    await loginWithPassword('a@b.c', 'pw');
    expect(calls).toBe(1);
  });

  it('토큰 갱신 성공 → 무효화', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })));
    await refreshAuthTokens();
    expect(calls).toBe(1);
  });

  it('로그아웃 → 무효화', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    await logoutUser('r');
    expect(calls).toBe(1);
  });

  it('세션 만료 신호 → 무효화', () => {
    signalSessionExpired();
    expect(calls).toBe(1);
  });
});
