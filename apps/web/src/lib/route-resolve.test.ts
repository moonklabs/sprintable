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

  it('rejects empty/undefined/malformed segments', () => {
    expect(looksLikeWorkspaceSegment(undefined)).toBe(false);
    expect(looksLikeWorkspaceSegment(null)).toBe(false);
    expect(looksLikeWorkspaceSegment('')).toBe(false);
    expect(looksLikeWorkspaceSegment('Has-Upper')).toBe(false);
    expect(looksLikeWorkspaceSegment('snake_case')).toBe(false);
    expect(looksLikeWorkspaceSegment('-leading-hyphen')).toBe(false);
    expect(looksLikeWorkspaceSegment('trailing-hyphen-')).toBe(false);
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
