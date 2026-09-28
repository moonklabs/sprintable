// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
describe('reopenCurrentUrlOnce — 같은 주소 전체 이동은 1회(story #4217 PO 무한 새로고침 위험)', () => {
  it('첫 번째만 이동 · 같은 주소 두 번째는 false(이동 0) · 표지를 지우면 다시 1회', async () => {
    const { reopenCurrentUrlOnce, clearReopenMarker } = await import('./hard-reload');
    clearReopenMarker();
    const go = vi.fn();
    expect(reopenCurrentUrlOnce(go)).toBe(true);
    expect(reopenCurrentUrlOnce(go)).toBe(false);
    expect(reopenCurrentUrlOnce(go)).toBe(false);
    expect(go).toHaveBeenCalledTimes(1);
    clearReopenMarker();
    expect(reopenCurrentUrlOnce(go)).toBe(true);
    expect(go).toHaveBeenCalledTimes(2);
    clearReopenMarker();
  });
});

describe('retryReopenCurrentUrl — 사람이 누른 «다시 시도»는 무조건 전체 이동(PO)', () => {
  it('⭐저장소가 던지는 환경: 자동 재오픈은 이동 0(루프보다 멈춤) · «다시 시도»는 이동 1회', async () => {
    const { reopenCurrentUrlOnce, retryReopenCurrentUrl } = await import('./hard-reload');
    // 쿠키·사이트 데이터 차단 브라우저처럼 sessionStorage 접근 자체가 던진다.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('storage blocked'); } });
    try {
      const go = vi.fn();
      expect(reopenCurrentUrlOnce(go)).toBe(false);
      expect(go).not.toHaveBeenCalled();
      retryReopenCurrentUrl(go);
      expect(go).toHaveBeenCalledTimes(1);
      expect(go).toHaveBeenCalledWith(window.location.href);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });

  it('저장소 정상: 표지를 이미 쓴 주소여도 «다시 시도»는 이동 1회(표지 새로 남김)', async () => {
    const { reopenCurrentUrlOnce, retryReopenCurrentUrl, clearReopenMarker } = await import('./hard-reload');
    clearReopenMarker();
    const go = vi.fn();
    reopenCurrentUrlOnce(go);
    expect(reopenCurrentUrlOnce(go)).toBe(false);
    retryReopenCurrentUrl(go);
    expect(go).toHaveBeenCalledTimes(2);
    expect(reopenCurrentUrlOnce(go)).toBe(false); // 다시 열어도 못 풀면 자동 이동은 다시 0
    clearReopenMarker();
  });
});
