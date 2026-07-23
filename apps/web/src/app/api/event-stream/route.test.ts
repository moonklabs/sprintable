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
