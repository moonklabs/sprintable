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

// story #2689(콜드 재진입 슬로우) — 그라운딩 중 핵심 질문: 콜드 재진입 시 GNB 마운트 시점에
// 동시에 쏘는 여러 fetchWithAuth 호출이 전부 401을 맞으면, refresh가 N번 각각 도는지 1번만
// 도는지. `_refreshing`(모듈 스코프 공유 promise) single-flight 설계가 실제로 그렇게 동작
// 하는지를 "추측 금지"(스토리 AC①) 원칙에 맞춰 직접 고정한다 — 응답 지연을 넣어 진짜 동시
// 호출 사이 레이스 창을 만든다(지연 없으면 매 await 지점마다 우연히 순차화돼 검증력이 약함).
describe('fetchWithAuth — 동시 401 N건 → refresh single-flight(story #2689 AC②)', () => {
  it('서로 다른 URL 3개가 동시에 401을 맞아도 /api/auth/refresh는 정확히 1번만 호출된다', async () => {
    let refreshCallCount = 0;
    const inFlightPerUrl = new Map<string, number>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/auth/refresh')) {
        refreshCallCount += 1;
        // 실 네트워크 왕복을 흉내(지연) — 지연이 없으면 이벤트루프상 순차 처리처럼 보여 동시성
        // 검증력이 약해진다(레이스 창을 실제로 만들어야 single-flight가 진짜 효과가 있는지 안다).
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ data: { access_token: 'new-at', refresh_token: 'new-rt', token_type: 'bearer' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const calls = (inFlightPerUrl.get(url) ?? 0) + 1;
      inFlightPerUrl.set(url, calls);
      // 이 URL로의 첫 호출(콜드 재진입 원 요청)만 401 — 재시도(refresh 후 두 번째 호출)는 200.
      if (calls === 1) return new Response(null, { status: 401 });
      return new Response(JSON.stringify({ data: { ok: true, url } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([
      fetchWithAuth('/api/gates?status=pending'),
      fetchWithAuth('/api/event-notifications/unread-count'),
      fetchWithAuth('/api/conversations/unread-count'),
    ]);

    expect(refreshCallCount).toBe(1);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(c.status).toBe(200);
  });
});
