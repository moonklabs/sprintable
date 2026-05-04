import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isOssMode, hashApiKey, queryMock, getDbMock } = vi.hoisted(() => ({
  isOssMode: vi.fn(),
  hashApiKey: vi.fn(),
  queryMock: vi.fn(),
  getDbMock: vi.fn(),
}));

vi.mock('@/lib/storage/factory', () => ({ isOssMode }));
vi.mock('@/lib/auth-api-key', () => ({ hashApiKey }));
vi.mock('@sprintable/storage-pglite', () => ({
  OSS_ORG_ID: 'oss-org',
  OSS_PROJECT_ID: 'oss-proj',
  OSS_MEMBER_ID: 'oss-member',
  getDb: getDbMock,
}));

import { getAuthContext } from './auth-helpers';

describe('getAuthContext — OSS 모드', () => {
  beforeEach(() => {
    isOssMode.mockReset();
    hashApiKey.mockReset();
    queryMock.mockReset();
    getDbMock.mockReset();
    isOssMode.mockReturnValue(true);
    hashApiKey.mockReturnValue('hashed-key');
    getDbMock.mockResolvedValue({ query: queryMock });
  });

  it('유효한 API Key → type: agent 반환', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 'key-1', team_member_id: 'member-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'member-1', org_id: 'oss-org', project_id: 'oss-proj', type: 'agent' }] })
      .mockResolvedValue({ rows: [] }); // UPDATE last_used_at

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_test123' },
    });

    const result = await getAuthContext(request);

    expect(result?.type).toBe('agent');
    expect(result?.id).toBe('member-1');
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('API Key 없음 → human fallback', async () => {
    const request = new Request('http://localhost');

    const result = await getAuthContext(request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('revoked_at 설정 key → human fallback', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_revoked' },
    });

    const result = await getAuthContext(request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
  });

  it('expires_at 만료 key → human fallback', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_expired' },
    });

    const result = await getAuthContext(request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
  });
});
