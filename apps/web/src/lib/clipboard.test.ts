// @vitest-environment jsdom
//
// story #3986(클래스 «거짓 성공 표시») — copyTextSafely는 writeText가 실제로
// 끝났을 때만 { ok: true }를 낸다. 실패(권한 거부·비보안 컨텍스트)는 삼키지
// 않고 { ok: false }로 호출부에 정직하게 알린다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextSafely } from './clipboard';

describe('copyTextSafely(story #3986)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('⭐navigator.clipboard.writeText 성공 — { ok: true }', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const result = await copyTextSafely('hello');
    expect(result).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('⭐navigator.clipboard.writeText 거부(권한 등) — { ok: false }(삼키지 않는다)', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const result = await copyTextSafely('hello');
    expect(result).toEqual({ ok: false });
  });

  it('navigator.clipboard 자체가 없는 환경(비보안 컨텍스트) — execCommand 폴백 성공하면 { ok: true }', async () => {
    vi.stubGlobal('navigator', {});
    document.execCommand = vi.fn().mockReturnValue(true);
    const result = await copyTextSafely('hello');
    expect(result).toEqual({ ok: true });
  });

  it('⭐execCommand 폴백도 실패하면 { ok: false }(무조건 성공으로 보이던 옛 결함 처방)', async () => {
    vi.stubGlobal('navigator', {});
    document.execCommand = vi.fn().mockReturnValue(false);
    const result = await copyTextSafely('hello');
    expect(result).toEqual({ ok: false });
  });
});
