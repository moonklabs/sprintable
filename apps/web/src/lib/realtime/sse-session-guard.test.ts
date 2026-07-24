// story #2160 — isSessionAlive 계약 고정: fetchWithAuth('/api/me')의 ok 여부를 그대로 반영하고,
// 네트워크 자체 예외는 세션 문제로 오판하지 않고 true(기존 백오프에 맡김)로 접는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/db/client';
import { isSessionAlive } from './sse-session-guard';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSessionAlive — #2160', () => {
  it('fetchWithAuth가 ok:true면 true를 반환한다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true } as Response);
    await expect(isSessionAlive()).resolves.toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/me');
  });

  it('fetchWithAuth가 ok:false(세션 죽음, 이미 signalSessionExpired 발화됨)면 false를 반환한다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
    await expect(isSessionAlive()).resolves.toBe(false);
  });

  it('fetchWithAuth 자체가 던지면(네트워크 예외) 세션 문제로 오판하지 않고 true를 반환한다', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('offline'));
    await expect(isSessionAlive()).resolves.toBe(true);
  });
});
