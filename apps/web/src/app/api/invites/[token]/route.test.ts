import { beforeEach, describe, expect, it, vi } from 'vitest';

// 라이브 재현(2026-07-21, story #2383 배포검수 중 발견) — 이 라우트가 public 옵션 없이
// proxyToFastapi를 호출해 "아직 계정이 없는 신규 사용자"가 보는 초대 프리뷰를 무조건 401로
// 막고 있었다. GET /api/invites/[token]은 반드시 { public: true }로 위임해야 한다.
const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

const PATH = '/api/v2/invites/[token]';
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/invites/tok-1');
const params = () => Promise.resolve({ token: 'tok-1' });

describe('GET /api/invites/[token] (초대 프리뷰 — 미인증 사용자용, public 위임 필수)', () => {
  beforeEach(() => proxyToFastapiWithParams.mockReset());

  it('미인증 사용자도 접근 가능하도록 { public: true }로 위임한다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(okRes({ org_name: '뭉클랩' }));
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(), PATH, { token: 'tok-1' }, { public: true },
    );
    expect((await res.json()).data).toMatchObject({ org_name: '뭉클랩' });
  });

  it('passes through proxy errors', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response('e', { status: 404 }));
    expect((await GET(req(), { params: params() })).status).toBe(404);
  });
});
