import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fastapiCallMock, checkRateLimitMock, getServerSessionMock } = vi.hoisted(() => ({
  fastapiCallMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
  getServerSessionMock: vi.fn(),
}));

vi.mock('@sprintable/storage-api', () => ({ fastapiCall: fastapiCallMock }));
vi.mock('@/lib/rate-limiter', () => ({ checkRateLimit: checkRateLimitMock }));
vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { getAuthContext } from './auth-helpers';

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
