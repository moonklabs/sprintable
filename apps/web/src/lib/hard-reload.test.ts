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
