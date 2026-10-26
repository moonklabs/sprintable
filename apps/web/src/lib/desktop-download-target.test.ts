// 4763 follow-up — the public download door's process cache: a good answer is kept for a short while, a read in flight is joined, a failure is never kept, the cache is per bucket, the read has a time limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDownloadTargetCache, DOWNLOAD_FETCH_TIMEOUT_MS, DOWNLOAD_TARGET_TTL_MS, publicDownloadTarget } from './desktop-download-target';

const A = 'sprintable-desktop-releases-dev';
const B = 'sprintable-desktop-releases';
const dmg = (bucket: string, build = 'f0a17c077') => `https://storage.googleapis.com/${bucket}/macos-electron/0.2.0/Sprintable-Dev-Setup-${build}-arm64.dmg`;
const ok = (url: unknown) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ url }) }) as unknown as Response;
const fakeFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => vi.fn(impl as unknown as typeof fetch);

beforeEach(() => {
  clearDownloadTargetCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T02:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('publicDownloadTarget (4763 follow-up)', () => {
  it('keeps a good answer for the TTL — one read for the requests inside it — and reads again once it is over', async () => {
    const f = fakeFetch(async () => ok(dmg(A)));
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    vi.setSystemTime(Date.now() + DOWNLOAD_TARGET_TTL_MS - 1);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    expect(f).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2); // the TTL is over
    f.mockImplementation((async () => ok(dmg(A, 'newbuild99'))) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A, 'newbuild99')); // a new dmg is served at most one TTL late
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('requests that arrive while a read is in flight join that one read', async () => {
    let release!: (r: Response) => void;
    const f = fakeFetch(() => new Promise<Response>((r) => { release = r; }));
    const first = publicDownloadTarget(A, f);
    const second = publicDownloadTarget(A, f);
    const third = publicDownloadTarget(A, f);
    release(ok(dmg(A)));
    expect(await Promise.all([first, second, third])).toEqual([dmg(A), dmg(A), dmg(A)]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a failure is never kept: an unreadable manifest, a non-JSON body and a url that is not ours each leave the next request to ask again', async () => {
    const f = fakeFetch(async () => { throw new Error('boom'); });
    expect(await publicDownloadTarget(A, f)).toBeNull();
    f.mockImplementation((async () => ({ ok: true, text: async () => 'not json' }) as unknown as Response) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBeNull();
    f.mockImplementation((async () => ok('https://evil.example/x.dmg')) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBeNull();
    f.mockImplementation((async () => ok(dmg(A))) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A)); // asked again — nothing bad was kept
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('is per bucket: a changed setting is never served the old bucket\'s file', async () => {
    const f = fakeFetch(async (url) => ok(url.includes(`/${B}/`) ? dmg(B) : dmg(A)));
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    expect(await publicDownloadTarget(B, f)).toBe(dmg(B));
    expect(f).toHaveBeenCalledTimes(2);
    expect(await publicDownloadTarget(B, f)).toBe(dmg(B)); // now B is the kept one
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a clock that went backwards does not keep an answer alive', async () => {
    const f = fakeFetch(async () => ok(dmg(A)));
    await publicDownloadTarget(A, f);
    vi.setSystemTime(Date.now() - 60_000);
    await publicDownloadTarget(A, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('the read has a time limit: every manifest fetch carries an AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS) signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = fakeFetch(async () => ok(dmg(A)));
    await publicDownloadTarget(A, f);
    expect(timeout).toHaveBeenCalledWith(DOWNLOAD_FETCH_TIMEOUT_MS);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cache).toBe('no-store'); // the read itself still goes past any front cache
  });

  it('a failed read logs the error NAME only — a message that carries a token never reaches the log arguments', async () => {
    const f = fakeFetch(async () => { throw new TypeError('fetch failed for https://x/?token=SECRET-4763-FU'); });
    await publicDownloadTarget(A, f);
    const log = vi.mocked(console.error);
    expect(log).toHaveBeenCalledWith('desktop_downloads.public_redirect_unavailable', 'TypeError');
    expect(log.mock.calls.flat().map(String).join('|')).not.toContain('SECRET-4763-FU');
  });
});
