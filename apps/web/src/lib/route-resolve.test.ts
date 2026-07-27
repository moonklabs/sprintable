import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  fetchResolve,
  looksLikeWorkspaceSegment,
  RESERVED_FIRST_SEGMENTS,
  signResolveCache,
  verifyResolveCache,
} from './route-resolve';

const JWT_SECRET = 'test-secret-for-route-resolve-tests';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  process.env['JWT_SECRET'] = JWT_SECRET;
  mockFetch.mockReset();
});

afterEach(() => {
  delete process.env['JWT_SECRET'];
});

describe('looksLikeWorkspaceSegment', () => {
  it('rejects every current live flat-route literal (S1 회귀 0 가드)', () => {
    // story a539c649 S1 핵심 안전장치 — 이 목록의 어느 하나라도 workspace slug로 오인되면
    // 그 라우트 전체가 즉시 장애난다(오르테가군 승인 스코프: reserved 가드로 flat 라우트 무회귀).
    for (const segment of RESERVED_FIRST_SEGMENTS) {
      expect(looksLikeWorkspaceSegment(segment)).toBe(false);
    }
  });

  it('accepts a plausible kebab-case workspace slug not in the reserved list', () => {
    expect(looksLikeWorkspaceSegment('moonklabs')).toBe(true);
    expect(looksLikeWorkspaceSegment('acme-corp')).toBe(true);
  });

  it('rejects only empty/undefined segments — no segment at all', () => {
    expect(looksLikeWorkspaceSegment(undefined)).toBe(false);
    expect(looksLikeWorkspaceSegment(null)).toBe(false);
    expect(looksLikeWorkspaceSegment('')).toBe(false);
  });

  // story #2039 AC3 — 예전엔 여기서 kebab·ASCII 형식까지 걸러 구 한글 slug(`장사왕`)가
  // resolve fetch 이전에 탈락했다(레거시 링크가 canonical로 안내받지 못하고 그냥 404).
  // RESERVED_FIRST_SEGMENTS만 가드로 남기고, 형식이 이상해도 resolve가 최종 판정하게 한다.
  it('더 이상 형식(kebab/ASCII)으로 거르지 않는다 — 구 slug 후보는 resolve가 판정한다', () => {
    expect(looksLikeWorkspaceSegment('장사왕')).toBe(true);
    expect(looksLikeWorkspaceSegment('Has-Upper')).toBe(true);
    expect(looksLikeWorkspaceSegment('snake_case')).toBe(true);
    expect(looksLikeWorkspaceSegment('-leading-hyphen')).toBe(true);
    expect(looksLikeWorkspaceSegment('trailing-hyphen-')).toBe(true);
  });
});

describe('signResolveCache / verifyResolveCache', () => {
  const context = { orgId: 'org-1', orgSlug: 'moonklabs', orgRole: 'admin', projectId: 'proj-1', projectSlug: 'sprintable' };

  it('round-trips a signed cache token for the matching slug pair', async () => {
    const token = await signResolveCache('moonklabs', 'sprintable', context);
    const verified = await verifyResolveCache(token, 'moonklabs', 'sprintable');
    expect(verified).toEqual(context);
  });

  it('rejects a token whose workspace slug no longer matches the URL', async () => {
    const token = await signResolveCache('moonklabs', 'sprintable', context);
    const verified = await verifyResolveCache(token, 'different-ws', 'sprintable');
    expect(verified).toBeNull();
  });

  it('rejects a token whose project slug no longer matches the URL', async () => {
    const token = await signResolveCache('moonklabs', 'sprintable', context);
    const verified = await verifyResolveCache(token, 'moonklabs', 'different-proj');
    expect(verified).toBeNull();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ wsSlug: 'moonklabs', projSlug: 'sprintable', ...context })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(JWT_SECRET));
    const verified = await verifyResolveCache(expired, 'moonklabs', 'sprintable');
    expect(verified).toBeNull();
  });

  it('rejects a tampered/forged token (다른 시크릿으로 서명 — 위조 불가 증명)', async () => {
    const forged = await new SignJWT({ wsSlug: 'moonklabs', projSlug: 'sprintable', ...context, orgRole: 'owner' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('50s')
      .sign(new TextEncoder().encode('wrong-secret'));
    const verified = await verifyResolveCache(forged, 'moonklabs', 'sprintable');
    expect(verified).toBeNull();
  });
});

describe('fetchResolve', () => {
  it('returns ok with the org/project context on a plain 200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'moonklabs', org_role: 'admin', project_id: 'proj-1', project_slug: 'sprintable' }),
    });
    const outcome = await fetchResolve('http://localhost:8000', 'moonklabs', 'sprintable', 'access-token');
    expect(outcome).toEqual({
      kind: 'ok',
      context: { orgId: 'org-1', orgSlug: 'moonklabs', orgRole: 'admin', projectId: 'proj-1', projectSlug: 'sprintable' },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/v2/resolve?workspace=moonklabs&project=sprintable',
      { headers: { Authorization: 'Bearer access-token' } },
    );
  });

  it('returns redirect when the BE response carries a redirect field (옛 slug rename-chase)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ org_id: 'org-1', org_slug: 'new-slug', org_role: 'member', redirect: { workspace: 'new-slug' } }),
    });
    const outcome = await fetchResolve('http://localhost:8000', 'old-slug', undefined, 'access-token');
    expect(outcome).toEqual({ kind: 'redirect', workspace: 'new-slug', project: undefined });
  });

  it('returns not_found on a non-ok response (org/project not found or no access)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const outcome = await fetchResolve('http://localhost:8000', 'ghost-ws', undefined, 'access-token');
    expect(outcome).toEqual({ kind: 'not_found' });
  });

  it('returns not_found on a network error (fail-closed, never throws)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const outcome = await fetchResolve('http://localhost:8000', 'moonklabs', undefined, 'access-token');
    expect(outcome).toEqual({ kind: 'not_found' });
  });
});
