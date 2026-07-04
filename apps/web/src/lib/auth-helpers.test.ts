import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fastapiCallMock, checkRateLimitMock, getServerSessionMock } = vi.hoisted(() => ({
  fastapiCallMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));

vi.mock('@sprintable/storage-api', () => ({ fastapiCall: fastapiCallMock }));
vi.mock('@/lib/rate-limiter', () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { getAuthContext, getOrgProjectAuthContext } from './auth-helpers';

describe('getAuthContext — SaaS 모드', () => {
  beforeEach(() => {
    fastapiCallMock.mockReset();
    checkRateLimitMock.mockReset();
    getServerSessionMock.mockReset();
    checkRateLimitMock.mockReturnValue({ allowed: true, remaining: 299, resetAt: 0 });
  });

  it('유효한 API Key → type: agent 반환', async () => {
    fastapiCallMock.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'Test Project',
      type: 'agent',
      scope: [],
    });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_test123' },
    });

    const result = await getAuthContext(request);

    expect(result?.type).toBe('agent');
    expect(result?.id).toBe('member-1');
  });

  it('API Key 없음 + 세션 있음 → human 반환', async () => {
    getServerSessionMock.mockResolvedValue({ access_token: 'valid-token' });
    fastapiCallMock.mockResolvedValue({
      id: 'member-2',
      org_id: 'org-1',
      project_id: 'proj-1',
      project_name: 'Test Project',
    });

    const request = new Request('http://localhost');
    const result = await getAuthContext(request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('member-2');
  });

  it('세션 없음 → null 반환', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const request = new Request('http://localhost');
    const result = await getAuthContext(request);

    expect(result).toBeNull();
  });
});

// story 7d6b770b: authz-only(org/project) 라우트 전용 경량 경로 — JWT claim 있으면
// GET /api/v2/me 재호출 없이 스킵, 없으면 fail-closed로 기존 /me fallback.
describe('getOrgProjectAuthContext — light path (story 7d6b770b)', () => {
  beforeEach(() => {
    fastapiCallMock.mockReset();
    checkRateLimitMock.mockReset();
    getServerSessionMock.mockReset();
    checkRateLimitMock.mockReturnValue({ allowed: true, remaining: 299, resetAt: 0 });
  });

  it('세션에 org_id/project_id claim 있으면 /me 호출 없이 스킵', async () => {
    getServerSessionMock.mockResolvedValue({
      access_token: 'valid-token', org_id: 'org-1', project_id: 'proj-1',
    });

    const request = new Request('http://localhost');
    const result = await getOrgProjectAuthContext(request);

    expect(result).toEqual({ org_id: 'org-1', project_id: 'proj-1', type: 'human' });
    expect(fastapiCallMock).not.toHaveBeenCalled();
  });

  it('claim 없으면(fail-closed) 기존 /me 왕복으로 fallback', async () => {
    getServerSessionMock.mockResolvedValue({
      access_token: 'valid-token', org_id: null, project_id: null,
    });
    fastapiCallMock.mockResolvedValue({
      id: 'member-2', org_id: 'org-1', project_id: 'proj-1', project_name: 'Test Project',
    });

    const request = new Request('http://localhost');
    const result = await getOrgProjectAuthContext(request);

    expect(fastapiCallMock).toHaveBeenCalledWith('GET', '/api/v2/me', 'valid-token');
    expect(result?.org_id).toBe('org-1');
    expect(result?.project_id).toBe('proj-1');
  });

  it('claim 중 하나만 있어도(부분) fail-closed로 /me fallback', async () => {
    getServerSessionMock.mockResolvedValue({
      access_token: 'valid-token', org_id: 'org-1', project_id: null,
    });
    fastapiCallMock.mockResolvedValue({
      id: 'member-2', org_id: 'org-1', project_id: 'proj-1', project_name: 'Test Project',
    });

    const request = new Request('http://localhost');
    await getOrgProjectAuthContext(request);

    expect(fastapiCallMock).toHaveBeenCalled();
  });

  it('세션 없음 → null 반환', async () => {
    getServerSessionMock.mockResolvedValue(null);

    const request = new Request('http://localhost');
    const result = await getOrgProjectAuthContext(request);

    expect(result).toBeNull();
  });

  it('API 키 경로는 무변경 — 여전히 /me 호출 + rate-limit 적용', async () => {
    fastapiCallMock.mockResolvedValue({
      id: 'member-1', org_id: 'org-1', project_id: 'proj-1',
      project_name: 'Test Project', type: 'agent', scope: [],
    });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_test123' },
    });
    const result = await getOrgProjectAuthContext(request);

    expect(fastapiCallMock).toHaveBeenCalledWith('GET', '/api/v2/me', 'sk_live_test123');
    expect(checkRateLimitMock).toHaveBeenCalledWith('member-1');
    expect(result?.type).toBe('agent');
  });
});
