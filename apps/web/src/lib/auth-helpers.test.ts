import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isOssMode, hashApiKey, prepareMock, getDbMock } = vi.hoisted(() => ({
  isOssMode: vi.fn(),
  hashApiKey: vi.fn(),
  prepareMock: vi.fn(),
  getDbMock: vi.fn(),
}));

vi.mock('@/lib/storage/factory', () => ({ isOssMode }));
vi.mock('@/lib/auth-api-key', () => ({ hashApiKey }));
vi.mock('@sprintable/storage-sqlite', () => ({
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
    prepareMock.mockReset();
    getDbMock.mockReset();
    isOssMode.mockReturnValue(true);
    hashApiKey.mockReturnValue('hashed-key');
    getDbMock.mockReturnValue({ prepare: prepareMock });
  });

  it('유효한 API Key → type: agent 반환', async () => {
    const getMock = vi.fn()
      .mockReturnValueOnce({ id: 'key-1', team_member_id: 'member-1' })
      .mockReturnValueOnce({ id: 'member-1', org_id: 'oss-org', project_id: 'oss-proj', type: 'agent' });
    const runMock = vi.fn();
    prepareMock.mockReturnValue({ get: getMock, run: runMock });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_test123' },
    });

    const result = await getAuthContext({} as never, request);

    expect(result?.type).toBe('agent');
    expect(result?.id).toBe('member-1');
    expect(runMock).toHaveBeenCalledOnce();
  });

  it('API Key 없음 → human fallback', async () => {
    const request = new Request('http://localhost');

    const result = await getAuthContext({} as never, request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('revoked_at 설정 key → human fallback', async () => {
    prepareMock.mockReturnValue({ get: vi.fn().mockReturnValue(null), run: vi.fn() });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_revoked' },
    });

    const result = await getAuthContext({} as never, request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
  });

  it('expires_at 만료 key → human fallback', async () => {
    prepareMock.mockReturnValue({ get: vi.fn().mockReturnValue(null), run: vi.fn() });

    const request = new Request('http://localhost', {
      headers: { Authorization: 'Bearer sk_live_expired' },
    });

    const result = await getAuthContext({} as never, request);

    expect(result?.type).toBe('human');
    expect(result?.id).toBe('oss-member');
  });
});
