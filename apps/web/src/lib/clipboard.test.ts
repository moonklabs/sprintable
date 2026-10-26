// @vitest-environment jsdom
//
// story #3986(클래스 «거짓 성공 표시») — copyTextSafely는 writeText가 실제로
// 끝났을 때만 { ok: true }를 낸다. 실패(권한 거부·비보안 컨텍스트)는 삼키지
// 않고 { ok: false }로 호출부에 정직하게 알린다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPromisedText, copyTextSafely } from './clipboard';

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

describe('copyPromisedText(story 4766)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the write starts BEFORE the text exists (inside the click) and carries it once it does', async () => {
    const written: Blob[] = [];
    const write = vi.fn(async (items: { __p: Promise<Blob> }[]) => { written.push(await items[0]!.__p); });
    class FakeItem { __p: Promise<Blob>; constructor(o: Record<string, Promise<Blob>>) { this.__p = o['text/plain']!; } }
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
    let resolve: (t: string) => void = () => undefined;
    const pending = new Promise<string>((r) => { resolve = r; });
    const result = copyPromisedText(pending);
    expect(write).toHaveBeenCalledTimes(1); // called synchronously, before the text was known
    resolve('the line');
    expect(await result).toEqual({ ok: true });
    expect(await written[0]!.text()).toBe('the line');
  });

  it('the text promise rejecting is { ok: false } — nothing claims a copy that did not happen', async () => {
    const write = vi.fn(async (items: { __p: Promise<Blob> }[]) => { await items[0]!.__p; });
    class FakeItem { __p: Promise<Blob>; constructor(o: Record<string, Promise<Blob>>) { this.__p = o['text/plain']!; } }
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { clipboard: { write } });
    expect(await copyPromisedText(Promise.reject(new Error('no line')))).toEqual({ ok: false });
  });

  it('without ClipboardItem the text is awaited and the ordinary path is used', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyPromisedText(Promise.resolve('late'))).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('late');
  });

  it('the write itself failing first, then the text promise rejecting, leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    class FakeItem { constructor(_o: Record<string, Promise<Blob>>) { /* the browser owns the promise */ } }
    vi.stubGlobal('ClipboardItem', FakeItem);
    vi.stubGlobal('navigator', { clipboard: { write: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) } });
    let reject: (e: unknown) => void = () => undefined;
    const pending = new Promise<string>((_, rej) => { reject = rej; });
    const result = await copyPromisedText(pending);
    reject(new Error('later failure'));
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);
    expect(result).toEqual({ ok: false });
    expect(unhandled).toEqual([]);
  });
});
