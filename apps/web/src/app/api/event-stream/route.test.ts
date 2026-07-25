import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// E-ARCH 1단계(story #2078) — /api/event-stream 프록시 업스트림 선택 회귀가드.
// REALTIME_URL이 설정돼 있으면 그쪽으로, 없으면 기존 NEXT_PUBLIC_FASTAPI_URL로 폴백 —
// "되돌리면 원복"(env 값을 비우면 코드 변경 없이 즉시 원래 경로로 복귀)을 고정한다.

const h = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.getServerSession }));

import { GET } from './route';

const ORIGINAL_ENV = { ...process.env };

describe('/api/event-stream — REALTIME_URL 전환(story #2078)', () => {
  beforeEach(() => {
    h.getServerSession.mockReset();
    h.getServerSession.mockResolvedValue({ access_token: 'tok' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('인증 없으면 401 — 업스트림 호출 자체를 안 한다', async () => {
    h.getServerSession.mockResolvedValue(null);
    const res = await GET(new Request('http://localhost/api/event-stream') as unknown as Parameters<typeof GET>[0]);
    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('REALTIME_URL이 설정돼 있으면 그쪽 /api/v2/events/stream으로 프록시한다', async () => {
    process.env['REALTIME_URL'] = 'https://sprintable-realtime-dev-787818285179.asia-northeast3.run.app';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app';

    await GET(new Request('http://localhost/api/event-stream?member_id=m1') as unknown as Parameters<typeof GET>[0]);

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(
      'https://sprintable-realtime-dev-787818285179.asia-northeast3.run.app/api/v2/events/stream?member_id=m1',
    );
  });

  it('REALTIME_URL이 없으면(원복) 기존 NEXT_PUBLIC_FASTAPI_URL로 폴백한다', async () => {
    delete process.env['REALTIME_URL'];
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app';

    await GET(new Request('http://localhost/api/event-stream?member_id=m1') as unknown as Parameters<typeof GET>[0]);

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(
      'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app/api/v2/events/stream?member_id=m1',
    );
  });

  it('REALTIME_URL이 빈 문자열이면(원복 케이스) 폴백한다 — falsy 취급', async () => {
    process.env['REALTIME_URL'] = '';
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app';

    await GET(new Request('http://localhost/api/event-stream') as unknown as Parameters<typeof GET>[0]);

    const calledUrl = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe(
      'https://sprintable-backend-dev-787818285179.asia-northeast3.run.app/api/v2/events/stream',
    );
  });
});

// story #2183 — request.signal이 upstream fetch로 안 넘어가 다운스트림(클라 연결·프론트 자신의
// 60초 요청컷)이 끝나도 upstream(realtime-gateway) 커넥션이 안 끊기던 결함. 재연결 1회마다
// 좀비 upstream 커넥션이 하나씩 쌓여 realtime 타임아웃(3600s) 상한까지 살아있었다(탭 1개당
// 누적 최대 ~60개 — 프론트가 60초마다 클라 쪽만 끊고 재연결하는 사이클과 정확히 맞아떨어짐).
describe('/api/event-stream — request.signal 전파(story #2183, 좀비 upstream 커넥션 방지)', () => {
  beforeEach(() => {
    h.getServerSession.mockReset();
    h.getServerSession.mockResolvedValue({ access_token: 'tok' });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('upstream fetch에 request.signal이 실제로 배선된다(실패 케이스 실증 — 이게 없으면 좀비가 남는다)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const req = new Request('http://localhost/api/event-stream', { signal: controller.signal });

    await GET(req as unknown as Parameters<typeof GET>[0]);

    const passedInit = fetchMock.mock.calls[0]?.[1];
    // ⚠️Node의 Request는 signal을 그대로 참조 전달하지 않고 내부적으로 "따라가는" 별도
    // AbortSignal을 노출한다(실측 — .toBe() 참조동일성이 깨짐) — 그래서 객체 동일성이 아니라
    // "컨트롤러를 abort하면 실제로 전파되는지"(기능 동일성)로 검증한다.
    expect(passedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(passedInit?.signal?.aborted).toBe(false);
    controller.abort();
    expect(passedInit?.signal?.aborted).toBe(true);
  });

  it('다운스트림이 이미 abort된 채로 들어오면(fetch가 AbortError로 거절) 499로 조용히 정리한다(예외 전파 없음)', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw abortError; }));
    const controller = new AbortController();
    controller.abort();
    const req = new Request('http://localhost/api/event-stream', { signal: controller.signal });

    const res = await GET(req as unknown as Parameters<typeof GET>[0]);

    expect(res.status).toBe(499);
  });

  it('AbortError가 아닌 다른 fetch 실패는 그대로 던진다(오탐 방지 — 진짜 네트워크 오류를 499로 감추지 않음)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const req = new Request('http://localhost/api/event-stream');

    await expect(GET(req as unknown as Parameters<typeof GET>[0])).rejects.toThrow('ECONNREFUSED');
  });

  it('정상 스트림(abort 없음)은 signal 배선 후에도 그대로 200으로 통과한다(AC4 — 조기종료 회귀 없음)', async () => {
    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(upstreamBody, { status: 200 })));
    const req = new Request('http://localhost/api/event-stream');

    const res = await GET(req as unknown as Parameters<typeof GET>[0]);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe('data: hello\n\n'); // 스트림이 잘리지 않고 끝까지 통과함
  });
});

// story #2183 후속(2026-07-25) — request.signal 단독으로는 Cloud Run의 강제 종료를 못 잡는다는
// 것이 라이브 실측으로 확認됐다(착지 前 n=300 전부 3601.0s → 착지 後에도 617~658s, ~60s가
// 나왔어야 했다). wall-clock 캡을 본체로 얹은 회귀가드 — AbortSignal.timeout은 vitest fake
// timer로 제어가 안 되므로(Node 내부 타이머라 실측 확認됨) AbortSignal.timeout 자체를 스파이/
// 교체해 "캡이 걸렸을 때"의 배선과 거동을 실시간 대기 없이 검증한다.
describe('/api/event-stream — wall-clock 상한(story #2183 후속, signal 단독 실패의 회귀가드)', () => {
  beforeEach(() => {
    h.getServerSession.mockReset();
    h.getServerSession.mockResolvedValue({ access_token: 'tok' });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('AbortSignal.timeout(55000)으로 wall-clock 캡을 건다 — 상수값 고정', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    await GET(new Request('http://localhost/api/event-stream') as unknown as Parameters<typeof GET>[0]);

    expect(timeoutSpy).toHaveBeenCalledWith(55_000);
  });

  it('wall-clock 캡이 fire되면(request.signal은 안 fire된 채로도) 499로 조용히 정리한다', async () => {
    // AbortSignal.timeout을 이미 abort된 신호로 교체 — "캡 도달" 시점을 실시간 대기 없이 재현.
    const timeoutController = new AbortController();
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    timeoutController.abort(timeoutError);
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response('', { status: 200 });
    }));
    const controller = new AbortController(); // request.signal 자체는 살아있음(클라 안 끊음)
    const req = new Request('http://localhost/api/event-stream', { signal: controller.signal });

    const res = await GET(req as unknown as Parameters<typeof GET>[0]);

    expect(res.status).toBe(499);
    expect(controller.signal.aborted).toBe(false); // 클라는 안 끊었다 — 캡이 본체로 작동한 것
  });

  it('request.signal 배선도 여전히 살아있다(캡과 별개 경로) — #2183 원래 회귀가드 유지', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const req = new Request('http://localhost/api/event-stream', { signal: controller.signal });

    await GET(req as unknown as Parameters<typeof GET>[0]);

    const passedSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(passedSignal?.aborted).toBe(false);
    controller.abort();
    expect(passedSignal?.aborted).toBe(true);
  });
});
