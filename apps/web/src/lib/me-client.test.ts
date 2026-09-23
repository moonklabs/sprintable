// story #4184 — `/api/me` 요청 공유(lib/me-client.ts)의 계약.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));

import { fetchMe, invalidateMe, ME_FRESH_MS } from './me-client';

function okMe(id = 'm-1') {
  return new Response(JSON.stringify({ data: { id } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  invalidateMe();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchMe — /api/me 요청 공유(story #4184)', () => {
  it('동시에 부른 여러 호출이 네트워크 요청 1회를 나눠 쓰고, 각자 본문을 읽을 수 있다', async () => {
    fetchWithAuthMock.mockResolvedValue(okMe());
    const responses = await Promise.all([fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe()]);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/me');
    for (const res of responses) expect(await res.json()).toEqual({ data: { id: 'm-1' } });
  });

  it('응답 뒤 ME_FRESH_MS 안의 호출은 재사용하고, 지나면 다시 부른다', async () => {
    vi.useFakeTimers({ now: 0 });
    fetchWithAuthMock.mockImplementation(async () => okMe());
    await fetchMe();
    vi.setSystemTime(ME_FRESH_MS - 1);
    await fetchMe();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(ME_FRESH_MS);
    await fetchMe();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('실패 응답은 저장하지 않는다 — 다음 호출이 곧바로 다시 부른다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(okMe());
    expect((await fetchMe()).ok).toBe(false);
    expect((await fetchMe()).ok).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('네트워크 예외는 그대로 던지고 저장하지 않는다', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(okMe());
    await expect(fetchMe()).rejects.toThrow('offline');
    expect((await fetchMe()).ok).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('fresh:true는 창을 무시하고 다시 부르며, 그 결과가 이후 호출의 공유 대상이 된다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okMe('old')).mockResolvedValueOnce(okMe('new'));
    await fetchMe();
    expect(await (await fetchMe({ fresh: true })).json()).toEqual({ data: { id: 'new' } });
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'new' } });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('invalidateMe() 뒤 호출은 다시 부른다(프로필 저장·org 전환·로그인/로그아웃 뒤)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okMe('before')).mockResolvedValueOnce(okMe('after'));
    await fetchMe();
    invalidateMe();
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'after' } });
  });
});

// ── 이관 전수 가드(AC2) ─────────────────────────────────────────────────────────────
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(e) && !e.includes('.test.') ? [full] : [];
  });
}

describe('/api/me 호출처 이관 전수(story #4184 AC2)', () => {
  // 네트워크가 곧 답이어야 하는 자리만 fetchMe를 안 쓴다:
  //  · sse-session-guard — 세션이 살아 있는지 실제로 물어야 한다(공유 값이면 죽은 세션을 산 것으로 오판).
  //  · invite-client — 초대 수락 전 로그인 여부 확認(한 번만, 셸 밖).
  //  · me-client — 공유 요청 그 자체.
  const RAW_ALLOWED = ['lib/realtime/sse-session-guard.ts', 'app/invite/invite-client.tsx', 'lib/me-client.ts'];

  it('허용 목록 밖에서 /api/me GET을 fetchWithAuth로 직접 부르지 않는다', () => {
    const raw = sources(SRC)
      .filter((f) => /fetchWithAuth\(\s*['"`]\/api\/me['"`]\s*\)/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(raw.sort()).toEqual([...RAW_ALLOWED].sort());
  });

  it('클라이언트에서 switch-org를 부르는 파일은 모두 invalidateMe()를 부른다', () => {
    const missing = sources(SRC)
      .filter((f) => { const src = readFileSync(f, 'utf8'); return /fetch\(\s*['"`]\/api\/switch-org/.test(src) && !src.includes('invalidateMe()'); })
      .map((f) => relative(SRC, f));
    expect(missing).toEqual([]);
  });

  it('/api/me PATCH(프로필 저장)를 부르는 파일은 invalidateMe()를 부른다', () => {
    const missing = sources(SRC)
      .filter((f) => { const src = readFileSync(f, 'utf8'); return /fetchWithAuth\(\s*['"`]\/api\/me['"`]\s*,\s*\{[\s\S]{0,80}PATCH/.test(src) && !src.includes('invalidateMe()'); })
      .map((f) => relative(SRC, f));
    expect(missing).toEqual([]);
  });
});
