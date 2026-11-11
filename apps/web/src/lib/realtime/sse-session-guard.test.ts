// @vitest-environment jsdom
// story #2160 — isSessionAlive 계약 고정: fetchWithAuth('/api/me')의 ok 여부를 그대로 반영하고,
// 네트워크 자체 예외는 세션 문제로 오판하지 않고 true(기존 백오프에 맡김)로 접는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '@/lib/db/client';
import { isSessionExpiredSignaled } from '@/lib/auth/session-expired-signal';
import { isSessionAlive, resetLeavingPageForTest } from './sse-session-guard';

vi.mock('@/lib/db/client', () => ({ fetchWithAuth: vi.fn() }));
// story 4902 — «세션 죽음»은 응답 ok가 아니라 이 신호(갱신 최종 실패)다
vi.mock('@/lib/auth/session-expired-signal', () => ({ isSessionExpiredSignaled: vi.fn(() => false) }));

beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset();
  vi.mocked(isSessionExpiredSignaled).mockReset();
  vi.mocked(isSessionExpiredSignaled).mockReturnValue(false);
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

  it('fetchWithAuth가 ok:false이고 세션 만료 신호가 올라 있으면(세션 죽음, signalSessionExpired 발화됨) false를 반환한다', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 401 } as Response);
    vi.mocked(isSessionExpiredSignaled).mockReturnValue(true);
    await expect(isSessionAlive()).resolves.toBe(false);
  });

  // story 4902 — 스트림이 거절돼 닫힐 때 `/api/me`가 순간 5xx를 내거나(업스트림 순단) 다른 창이 먼저 갱신해 이 창의 갱신이 «superseded»(원래 401을 돌려줌 · 세션은 서 있음)로 끝나도,
  // 응답이 ok가 아니란 이유만으로 «죽음»이라 하면 스트림이 다시 붙지 않고 닫힌 채 남는다. 신호가 없으면 산 것이다.
  it.each([[503], [502], [429], [401]])('⭐ 4902: ok:false(%i)여도 만료 신호가 없으면 살아 있다(true) — 스트림이 포기하지 않고 백오프 재시도에 맡겨진다', async (status) => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status } as Response);
    await expect(isSessionAlive()).resolves.toBe(true);
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
    vi.mocked(isSessionExpiredSignaled).mockReturnValue(true);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    await expect(isSessionAlive()).resolves.toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('beforeunload가 취소돼 페이지에 남으면 유예 뒤 진짜 만료를 다시 잡는다', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false } as Response);
      vi.mocked(isSessionExpiredSignaled).mockReturnValue(true);
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
