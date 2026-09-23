// story #4184 — `/api/me` 공유(lib/me-client.ts)의 계약: 진행 중 합류 + 성공 결과 재사용(맥락별) + 무효화.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));

import { fetchMe } from './me-client';
import { invalidateMeCache } from '@/lib/auth/me-invalidation';
import { setEffectiveOrgId, setEffectiveProjectId } from '@/lib/project-context-client';

function okMe(id = 'm-1') {
  return new Response(JSON.stringify({ data: { id } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  invalidateMeCache();
  setEffectiveOrgId(undefined);
  setEffectiveProjectId(undefined);
});

describe('fetchMe — 진행 중 /api/me 요청 공유(story #4184)', () => {
  it('동시에 부른 여러 호출이 네트워크 요청 1회를 나눠 쓰고, 각자 본문을 읽을 수 있다', async () => {
    fetchWithAuthMock.mockResolvedValue(okMe());
    const responses = await Promise.all([fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe(), fetchMe()]);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/me');
    for (const res of responses) expect(await res.json()).toEqual({ data: { id: 'm-1' } });
  });

  // 배포 18 라이브(PO CDP 하드 로드) 3회의 원인 — 설정 화면 절들이 첫 응답이 끝난 뒤(~1초 뒤) 차례로 마운트해
  // 합류할 진행 중 요청이 없었다. 성공 결과를 같은 맥락에서 재사용한다.
  it('응답이 온 뒤의 같은 맥락 호출은 네트워크 없이 그 결과를 재사용한다(순차 마운트)', async () => {
    fetchWithAuthMock.mockResolvedValue(okMe('first'));
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'first' } });
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'first' } });
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'first' } });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('무효화 뒤 호출은 다시 부른다(로그인·쓰기·401·만료 뒤 낡은 값 0)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okMe('before')).mockResolvedValueOnce(okMe('after'));
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'before' } });
    invalidateMeCache();
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'after' } });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('무효화 전에 출발한 요청이 뒤늦게 와도 그 값은 저장하지 않는다(쓰기 직전 값이 쓰기 뒤 캐시로 남는 경합)', async () => {
    let resolveOld!: (r: Response) => void;
    fetchWithAuthMock
      .mockImplementationOnce(() => new Promise<Response>((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(okMe('fresh'));
    const old = fetchMe();
    invalidateMeCache(); // 예: 프로필 저장(PATCH)이 나갔다
    resolveOld(okMe('stale'));
    expect(await (await old).json()).toEqual({ data: { id: 'stale' } }); // 이미 기다리던 호출부는 자기 응답을 받는다
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'fresh' } }); // 그 값은 캐시로 안 남는다
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('무효화는 진행 중 요청도 떼어 낸다 — 무효화 뒤 호출은 그 요청에 합류하지 않는다', async () => {
    let resolveOld!: (r: Response) => void;
    fetchWithAuthMock
      .mockImplementationOnce(() => new Promise<Response>((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(okMe('fresh'));
    const old = fetchMe();
    invalidateMeCache();
    const after = fetchMe();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    resolveOld(okMe('stale'));
    expect(await (await after).json()).toEqual({ data: { id: 'fresh' } });
    await old;
  });

  it('맥락(org·project)이 바뀌면 저장된 결과를 안 쓰고 새로 부른다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okMe('proj-a')).mockResolvedValueOnce(okMe('proj-b'));
    setEffectiveOrgId('org-a'); setEffectiveProjectId('proj-a');
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'proj-a' } });
    setEffectiveProjectId('proj-b');
    expect(await (await fetchMe()).json()).toEqual({ data: { id: 'proj-b' } });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('전환 직전에 출발한 요청이 진행 중이어도 전환 뒤 호출은 합류하지 않고 새로 보낸다(맥락 키)', async () => {
    let resolveOld!: (r: Response) => void;
    fetchWithAuthMock
      .mockImplementationOnce(() => new Promise<Response>((r) => { resolveOld = r; }))
      .mockResolvedValueOnce(okMe('after-switch'));
    setEffectiveOrgId('org-a'); setEffectiveProjectId('proj-a');
    const before = fetchMe();
    setEffectiveProjectId('proj-b'); // 프로젝트 전환(인터셉터가 싣는 맥락이 바뀜)
    const after = fetchMe();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    resolveOld(okMe('before-switch'));
    expect(await (await after).json()).toEqual({ data: { id: 'after-switch' } });
    expect(await (await before).json()).toEqual({ data: { id: 'before-switch' } });
  });

  it('맥락이 같으면 그대로 합류한다', async () => {
    fetchWithAuthMock.mockResolvedValue(okMe());
    setEffectiveOrgId('org-a'); setEffectiveProjectId('proj-a');
    await Promise.all([fetchMe(), fetchMe()]);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('실패 응답은 그대로 돌려주고 저장하지 않는다 — 다음 호출은 다시 부른다', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(okMe());
    expect((await fetchMe()).ok).toBe(false);
    expect((await fetchMe()).ok).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('네트워크 예외는 진행 중 호출 모두에 그대로 던지고, 다음 호출은 다시 부른다', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(okMe());
    const [a, b] = [fetchMe(), fetchMe()];
    await expect(a).rejects.toThrow('offline');
    await expect(b).rejects.toThrow('offline');
    expect((await fetchMe()).ok).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });
});

// ── 이관 전수 가드(AC2 · PR #4548 까디르 QA ③: 호출 모양 무관) ─────────────────────────────
const SRC = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(e) && !e.includes('.test.') ? [full] : [];
  });
}

// `/api/me` 문자열 리터럴 자체(따옴표 3종 · 쿼리스트링 포함) — fetch/fetchWithAuth·옵션 객체 유무와
// 상관없이 잡는다. `/api/me/...` 하위 경로(다른 엔드포인트)는 대상이 아니다.
const ME_LITERAL = /['"`]\/api\/me(?:\?[^'"`]*)?['"`]/;

describe('/api/me 호출처 이관 전수(story #4184 AC2)', () => {
  // fetchMe를 안 쓰는 자리와 이유:
  //  · me-client — 공유 요청 그 자체.
  //  · sse-session-guard — 세션이 살아 있는지 매번 실제로 물어야 한다.
  //  · invite-client — 초대 수락 전 로그인 여부 확認(셸 밖, 한 번).
  //  · register/page — 가입 직후 raw fetch(세션 쿠키가 막 세워진 인증 전 경로, fetchWithAuth의
  //    refresh 재시도를 타면 안 된다).
  //  · my-profile-section — PATCH(프로필 저장, 읽기가 아니라 변경) 1곳뿐.
  // 파일별 리터럴 개수까지 고정한다 — 허용 파일 안에 GET이 새로 생겨도 개수가 늘어 잡힌다.
  const ALLOWED: Record<string, number> = {
    'lib/me-client.ts': 1,
    'lib/realtime/sse-session-guard.ts': 1,
    'app/invite/invite-client.tsx': 1,
    'app/register/page.tsx': 1,
    'components/settings/my-profile-section.tsx': 1,
  };

  it('허용 목록 밖 소스에 /api/me 리터럴이 없고, 허용 파일도 정해진 개수만(호출 모양 무관)', () => {
    const hits: Record<string, number> = {};
    for (const f of sources(SRC)) {
      const n = readFileSync(f, 'utf8').split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && ME_LITERAL.test(line)).length;
      if (n > 0) hits[relative(SRC, f)] = n;
    }
    expect(hits).toEqual(ALLOWED);
  });

  it('가드 자체 — fetch·옵션 객체·쿼리스트링 모양도 잡고, 하위 경로는 안 잡는다', () => {
    expect(ME_LITERAL.test(`fetch('/api/me')`)).toBe(true);
    expect(ME_LITERAL.test(`fetchWithAuth("/api/me", { cache: 'no-store' })`)).toBe(true);
    expect(ME_LITERAL.test('fetchWithAuth(`/api/me?fields=role`)')).toBe(true);
    expect(ME_LITERAL.test(`fetchWithAuth('/api/me/memberships')`)).toBe(false);
  });
});
