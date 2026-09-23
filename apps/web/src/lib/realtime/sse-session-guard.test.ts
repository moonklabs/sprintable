// @vitest-environment jsdom
// story #2160 — isSessionAlive 계약 고정: fetchWithAuth('/api/me')의 ok 여부를 그대로 반영하고,
// 네트워크 자체 예외는 세션 문제로 오판하지 않고 true(기존 백오프에 맡김)로 접는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/db/client';
import { isSessionAlive, resetLeavingPageForTest } from './sse-session-guard';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
  resetLeavingPageForTest();
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

// story #4184(배포 18 라이브 PO CDP) — /chats → /settings 하드 이동에서 떠나는 페이지의 EventSource가 이동 때문에
// 끊기며 낸 CLOSED error가 `/api/me`를 한 번 더 불렀다. 페이지를 떠나는 중엔 묻지 않는다(진짜 만료 감지는 유지).
describe('isSessionAlive — 페이지를 떠나는 중엔 세션을 묻지 않는다(story #4184)', () => {
  it.each(['beforeunload', 'pagehide'])('%s 뒤 → /api/me 0회 · true', async (eventName) => {
    window.dispatchEvent(new Event(eventName));
    await expect(isSessionAlive()).resolves.toBe(true);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('pageshow(뒤로 가기 캐시 복귀)면 다시 묻는다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    await expect(isSessionAlive()).resolves.toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('beforeunload가 취소돼 페이지에 남으면 유예 뒤 진짜 만료를 다시 잡는다', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
      window.dispatchEvent(new Event('beforeunload'));
      await expect(isSessionAlive()).resolves.toBe(true);
      vi.advanceTimersByTime(5000);
      await expect(isSessionAlive()).resolves.toBe(false);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('음성대조 — 이동 신호가 없으면 예전처럼 묻는다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true } as Response);
    await expect(isSessionAlive()).resolves.toBe(true);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
