// @vitest-environment jsdom
//
// story #2160 — fetchWithAuth가 signalSessionExpired 이후엔 네트워크를 타지 않는지 고정한다.
// 이게 없으면 401 폴링/SSE 재연결 루프가 세션이 죽은 뒤에도 매 tick마다 refresh를 재시도해
// "401에는 재시도하지 않는다"는 처방이 무력화된다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FETCH_WITH_AUTH_DEFAULT_TIMEOUT_MS, fetchWithAuth, loginWithPassword, refreshAuthTokens } from './client';
import { fetchMe } from '@/lib/me-client';
import { isSessionExpiredSignaled, resetSessionExpired, signalSessionExpired } from '@/lib/auth/session-expired-signal';

beforeEach(() => {
  resetSessionExpired();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionExpired();
  delete window.ReactNativeWebView;
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

// story #4089(페드루 PO 리뷰 REQUIRED, AC2 두 번째 클래스) — material-lineage 실사고의
// 진짜 근원: refreshAuthTokens()는 BE가 401을 줘도 throw하지 않고 {error:{...}}로 정상
// resolve한다(callAuthRoute 정의, 아래 failAuthResponse가 그 shape). 예전 코드는 그래서
// "refresh 최종 실패"를 catch(네트워크 예외)만으로 판정했는데, 실제로는 한 번도 그
// catch를 못 타는 경로가 있었고(refresh가 401로 정상 resolve하는 흔한 경우), 대신
// "재시도까지 401"이면 signalSessionExpired()를 불러 그게 사실상의 유일한 판정축이
// 됐다 — 그 축은 "이 세션이 죽었다"와 "이 엔드포인트 하나가 (세션과 무관하게) 401을
// 낸다"를 구분 못 한다. 처방 확認 — 신호는 refresh가 진짜 실패(예외 또는 error 필드)한
// 경우에서만 나오고, refresh가 성공했는데 원 요청이 다시 401을 내는 것만으로는 신호가
// 안 뜬다(호출부가 그 401을 알아서 처리 — 세션 만료 취급 안 함).
describe('fetchWithAuth — 세션만료 신호는 refresh 최종 실패에서만(story #4089 AC2)', () => {
  it('401→refresh 성공→재시도도 401 — 신호 0(임의 엔드포인트의 401일 뿐, 세션 문제 아님)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(JSON.stringify({ data: { access_token: 'new-at', refresh_token: 'new-rt', token_type: 'bearer' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 401 }); // 원 URL은 refresh 성공 후에도 계속 401(BFF 없는 엔드포인트류).
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithAuth('/api/v2/some-broken-endpoint');

    expect(res.status).toBe(401);
    expect(isSessionExpiredSignaled()).toBe(false);
  });

  it('refresh 자체가 실패(error 응답)하면 신호 1', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(JSON.stringify({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'expired' } }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/api/gates');

    expect(isSessionExpiredSignaled()).toBe(true);
  });

  it('refresh 네트워크 예외(throw)에도 신호 1(기존 catch 경로 회귀 0)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/auth/refresh')) throw new Error('network down');
      return new Response(null, { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithAuth('/api/gates');

    expect(isSessionExpiredSignaled()).toBe(true);
  });

  it('refresh 성공+재시도도 성공(정상 회복) — 신호 0, 최종 응답 200', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('/api/auth/refresh')) {
        return new Response(JSON.stringify({ data: { access_token: 'new-at', refresh_token: 'new-rt', token_type: 'bearer' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithAuth('/api/gates');

    expect(res.status).toBe(200);
    expect(isSessionExpiredSignaled()).toBe(false);
  });
});

// story #3302(#2459 진단 (c) 갈래, AC1/AC3) — login/register/refresh 공통 choke point
// (callAuthRoute)의 성공 분기가 네이티브 셸에 session-changed를 정확히 1회 알리는지,
// 실패 분기는 0회인지 pin한다. 뮤테이션 자가검증(AC3) — callAuthRoute의 notifySessionChanged()
// 호출 한 줄을 지우면 아래 세 성공 케이스가 전부 RED로 떨어져야 한다(직접 지워서 확認).
function okAuthResponse() {
  return new Response(
    JSON.stringify({ data: { access_token: 'at', refresh_token: 'rt', token_type: 'bearer' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
function failAuthResponse() {
  return new Response(
    JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'bad' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

describe('callAuthRoute → notifySessionChanged 브릿지(story #3302 AC1/AC3)', () => {
  it('loginWithPassword 성공 시 셸에 session-changed가 정확히 1회 간다', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    vi.stubGlobal('fetch', vi.fn(async () => okAuthResponse()));
    await loginWithPassword('a@b.com', 'pw');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'session-changed' }));
  });

  it('refreshAuthTokens 성공 시 셸에 session-changed가 정확히 1회 간다(가장 빈번한 경로 — #2459 진단 (c)의 핵심 창)', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    vi.stubGlobal('fetch', vi.fn(async () => okAuthResponse()));
    await refreshAuthTokens();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('실패(401 등) 응답이면 셸에 아무것도 안 보낸다', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    vi.stubGlobal('fetch', vi.fn(async () => failAuthResponse()));
    await loginWithPassword('a@b.com', 'wrong');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('셸 밖(브라우저)에서 로그인 성공해도 예외 없이 조용하다(AC2)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okAuthResponse()));
    await expect(loginWithPassword('a@b.com', 'pw')).resolves.toMatchObject({ error: null });
  });
});

// story #4184(PR #4548 까디르 QA ②) — 세션 만료 신호가 난 뒤의 fetchMe()는 앞서 받은 200을
// 돌려주지 않고 실제 fetchWithAuth 경로(신호 뒤 즉시 401)를 탄다 — 호출부의 실패 갈래가 산다.
describe('fetchMe — 세션 만료 신호 뒤(story #4184)', () => {
  it('앞서 200을 받았어도 만료 신호 뒤엔 401을 돌려준다(저장해 둔 값이 없다)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: 'm-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchMe()).status).toBe(200);
    signalSessionExpired();
    expect((await fetchMe()).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// story #4310 — fetchWithAuth의 기본 시간 제한(응답 헤더까지). 예전엔 제한이 없어 응답 없는 요청 하나가 화면을 ~100초(CF 524) 로딩에 묶었다.
describe('fetchWithAuth — 응답 헤더까지 시간 제한(story #4310)', () => {
  /** 실제 fetch처럼: 신호가 끊기면 그 이유로 reject, `respondAt`이 오면 헤더(Response)로 resolve. */
  function hangingFetch(respond?: { afterMs: number; status?: number }) {
    const calls: { input: unknown; init?: RequestInit }[] = [];
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        if (respond) setTimeout(() => resolve(new Response('{}', { status: respond.status ?? 200 })), respond.afterMs);
      });
    });
    return { fetchMock, calls };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('⭐응답 헤더가 30s 안에 안 오면 TimeoutError로 reject(망 오류와 같은 실패 갈래 · AbortError 아님)', async () => {
    const { fetchMock, calls } = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithAuth('/api/stories');
    const settled = p.then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls[0]!.init?.signal?.aborted, '30s 전엔 안 끊음').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(FETCH_WITH_AUTH_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('⭐헤더가 오면 타이머를 푼다 — 그 뒤 시간이 지나도 신호가 안 끊겨 본문 읽기 · 큰 다운로드가 안 잘림', async () => {
    const { fetchMock, calls } = hangingFetch({ afterMs: 1_000 });
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithAuth('/api/docs');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).status).toBe(200);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls[0]!.init?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount(), '남은 타이머 0').toBe(0);
  });

  it('⭐호출자 signal을 존중 — 호출자가 끊으면 그 이유(AbortError)로 · 먼저 끊는 쪽이 이긴다', async () => {
    const { fetchMock } = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const p = fetchWithAuth('/api/stories', { signal: controller.signal });
    const settled = p.then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    const err = await settled;
    expect((err as DOMException).name).toBe('AbortError');
    expect(vi.getTimerCount(), '시간 제한 타이머도 풀림').toBe(0);
  });

  it('이미 끊긴 호출자 signal이면 바로 그 이유로 reject', async () => {
    const { fetchMock } = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchWithAuth('/api/stories', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('⭐호출별 덮어쓰기 — timeoutMs 130s(오피스 변환)는 30s엔 안 끊고 130s에 끊음 · timeoutMs는 fetch로 새지 않음', async () => {
    const { fetchMock, calls } = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithAuth('/api/attachments/convert?asset_id=a', { method: 'POST', timeoutMs: 130_000 });
    const settled = p.then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls[0]!.init?.signal?.aborted).toBe(false);
    expect(calls[0]!.init).not.toHaveProperty('timeoutMs');
    expect(calls[0]!.init?.method).toBe('POST');
    await vi.advanceTimersByTimeAsync(100_000);
    expect((await settled as DOMException).name).toBe('TimeoutError');
  });

  it('⭐긴 작업 대표 — 오피스 변환(timeoutMs 130s)은 60s 걸린 응답도 성공으로 받는다(기본 30s였다면 끊겼을 자리)', async () => {
    const { fetchMock } = hangingFetch({ afterMs: 60_000 });
    vi.stubGlobal('fetch', fetchMock);
    const p = fetchWithAuth('/api/attachments/convert?asset_id=a', { method: 'POST', timeoutMs: 130_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await p).status).toBe(200);
  });

  it('timeoutMs: false = 제한 없음(init 그대로 · 신호 추가 없음)', async () => {
    const { fetchMock, calls } = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);
    void fetchWithAuth('/api/x', { timeoutMs: false }).catch(() => {});
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls[0]!.init?.signal).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('⭐401 → 갱신 → 재시도도 같은 제한 — 재시도가 걸리면 30s 뒤 TimeoutError', async () => {
    let n = 0;
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      if (String(input) === '/api/auth/refresh') return Promise.resolve(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
      n += 1;
      if (n === 1) return Promise.resolve(new Response(null, { status: 401 }));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const settled = fetchWithAuth('/api/stories').then(() => 'resolved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await settled as DOMException).name).toBe('TimeoutError');
    expect(n).toBe(2);
  });
});
