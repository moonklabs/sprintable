// 4763 follow-up — the public download door's process cache: a good answer is kept for a short while, a read in flight is joined, a failure is never kept, the cache is per bucket, the read has a time limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDownloadTargetCache, DOWNLOAD_FAILURE_MEMORY_MS, DOWNLOAD_FETCH_TIMEOUT_MS, DOWNLOAD_STALE_MAX_MS, DOWNLOAD_TARGET_TTL_MS, publicDownloadTarget } from './desktop-download-target';

const A = 'sprintable-desktop-releases-dev';
const B = 'sprintable-desktop-releases';
const dmg = (bucket: string, build = 'f0a17c077') => `https://storage.googleapis.com/${bucket}/macos-electron/0.2.0/Sprintable-Dev-Setup-${build}-arm64.dmg`;
const ok = (url: unknown) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ url }) }) as unknown as Response;
const fakeFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => vi.fn(impl as unknown as typeof fetch);

beforeEach(() => {
  clearDownloadTargetCache();
  vi.useFakeTimers({ toFake: ['Date', 'performance'] }); // the TTL is measured on performance.now (monotonic); Date is the wall clock
  vi.setSystemTime(new Date('2026-10-26T02:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('publicDownloadTarget (4763 follow-up)', () => {
  it('keeps a good answer for the TTL — one read for the requests inside it — and reads again once it is over', async () => {
    const f = fakeFetch(async () => ok(dmg(A)));
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS - 1);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    expect(f).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2); // the TTL is over
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

  it('a failure is never kept as an answer: an unreadable manifest, a non-JSON body and a url that is not ours each leave the next request — after the short rest — to ask again', async () => {
    const f = fakeFetch(async () => { throw new Error('boom'); });
    expect(await publicDownloadTarget(A, f)).toBeNull();
    vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
    f.mockImplementation((async () => ({ ok: true, text: async () => 'not json' }) as unknown as Response) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBeNull();
    vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
    f.mockImplementation((async () => ok('https://evil.example/x.dmg')) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBeNull();
    vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
    f.mockImplementation((async () => ok(dmg(A))) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A)); // asked again — nothing bad was kept
    expect(f).toHaveBeenCalledTimes(4);
  });

  // the PO / Kadir's note (a): a joined read ties concurrency to one, not frequency — a bucket outage must not become one read per request
  it('a failed bucket rests for DOWNLOAD_FAILURE_MEMORY_MS: N requests during an outage → one read; the rest ends exactly then; recovery keeps the good answer; another bucket is not resting', async () => {
    const f = fakeFetch(async (url) => {
      if (url.includes(`/${A}/`)) throw new Error('outage');
      return ok(dmg(B));
    });
    expect(await publicDownloadTarget(A, f)).toBeNull(); // the read that failed
    for (let i = 0; i < 300; i += 1) expect(await publicDownloadTarget(A, f)).toBeNull(); // the same 502, no read
    expect(f).toHaveBeenCalledTimes(1);
    expect(await publicDownloadTarget(B, f)).toBe(dmg(B)); // another bucket is not resting
    expect(f).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS - 1);
    expect(await publicDownloadTarget(A, f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(2); // still resting
    vi.advanceTimersByTime(1); // the rest is over (exclusive end)
    expect(await publicDownloadTarget(A, f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(3); // asked again — and it failed again, so it rests again
    expect(await publicDownloadTarget(A, f)).toBeNull();
    expect(f).toHaveBeenCalledTimes(3);
    // recovery: once the rest is over and the read is good, the answer is kept and the memory is gone
    vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
    f.mockImplementation((async () => ok(dmg(A))) as unknown as typeof fetch);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
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

  it('the TTL runs on the monotonic clock: a wall clock set back does not bring an EXPIRED answer back', async () => {
    const f = fakeFetch(async () => ok(dmg(A)));
    await publicDownloadTarget(A, f);
    vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS + 1000); // expired
    vi.setSystemTime(Date.now() - DOWNLOAD_TARGET_TTL_MS); // the wall clock is put back to «just after the answer was kept»
    await publicDownloadTarget(A, f);
    expect(f).toHaveBeenCalledTimes(2); // asked again (a wall-clock TTL would have served the old answer)
  });

  // codex round 1 (blocking): A starts, B starts, then A is asked again — with one slot the second A read did not join the first and the older answer could overwrite the newer
  it('two buckets reading at once do not disturb each other: A, B, A again — one read per bucket, each answer lands on its own bucket', async () => {
    const release: Record<string, (r: Response) => void> = {};
    const f = fakeFetch((url) => new Promise<Response>((r) => { release[url.includes(`/${B}/`) ? 'B' : 'A'] = r; }));
    const a1 = publicDownloadTarget(A, f);
    const b1 = publicDownloadTarget(B, f);
    const a2 = publicDownloadTarget(A, f); // joins a1 — not a second A read
    expect(f).toHaveBeenCalledTimes(2);
    release.B!(ok(dmg(B)));
    release.A!(ok(dmg(A)));
    expect(await Promise.all([a1, b1, a2])).toEqual([dmg(A), dmg(B), dmg(A)]);
    expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
    expect(await publicDownloadTarget(B, f)).toBe(dmg(B));
    expect(f).toHaveBeenCalledTimes(2); // both kept, nothing read again
  });

  it('the read has a time limit: the signal fetch gets is the one AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS) made — and a read that times out ends as a caught null, not a hang', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = fakeFetch(async () => ok(dmg(A)));
    await publicDownloadTarget(A, f);
    expect(timeout).toHaveBeenCalledWith(DOWNLOAD_FETCH_TIMEOUT_MS);
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(timeout.mock.results[0]!.value); // not just «some signal»
    expect(init.cache).toBe('no-store'); // the read itself still goes past any front cache
    // a fetch that never answers on its own: it ends only because the signal aborts it → null (the route's 502), logged by name
    clearDownloadTargetCache();
    timeout.mockImplementation(() => AbortSignal.abort(new DOMException('The operation timed out', 'TimeoutError')));
    const hung = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason);
      else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    expect(await publicDownloadTarget(A, hung)).toBeNull();
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('desktop_downloads.public_redirect_unavailable', 'TimeoutError');
  });

  it('a failed read logs the error NAME only — a message that carries a token never reaches the log arguments', async () => {
    const f = fakeFetch(async () => { throw new TypeError('fetch failed for https://x/?token=SECRET-4763-FU'); });
    await publicDownloadTarget(A, f);
    const log = vi.mocked(console.error);
    expect(log).toHaveBeenCalledWith('desktop_downloads.public_redirect_unavailable', 'TypeError');
    expect(log.mock.calls.flat().map(String).join('|')).not.toContain('SECRET-4763-FU');
  });

  // 4763 follow-up (PO): a customer pressing «받기» at the moment of ONE failed refresh must not meet a 502 — the last checked url stands in while the manifest cannot be READ
  describe('stale-if-error', () => {
    const unreadable: Array<[string, () => ReturnType<typeof fakeFetch>]> = [
      ['a thrown error', () => fakeFetch(async () => { throw new Error('boom'); })],
      ['a body that is not JSON', () => fakeFetch(async () => ({ ok: true, text: async () => 'not json' }) as unknown as Response)],
      ['a read that times out', () => fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }))],
    ];

    it.each(unreadable)('a refresh that could not read the manifest (%s) serves the last checked url — never a 502 for a bucket that had a good answer', async (_name, make) => {
      const good = fakeFetch(async () => ok(dmg(A)));
      expect(await publicDownloadTarget(A, good)).toBe(dmg(A));
      vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS + 1); // expired: the next request refreshes
      if (_name === 'a read that times out') vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('The operation timed out', 'TimeoutError')));
      const broken = make();
      expect(await publicDownloadTarget(A, broken)).toBe(dmg(A)); // the stale url, not null
      expect(broken).toHaveBeenCalledTimes(1);
      // during the rest the same stale url, without a new read
      expect(await publicDownloadTarget(A, broken)).toBe(dmg(A));
      expect(broken).toHaveBeenCalledTimes(1);
    });

    it('the stale url is not a new answer: after the rest the next request refreshes again, and a good read replaces it', async () => {
      const f = fakeFetch(async () => ok(dmg(A)));
      await publicDownloadTarget(A, f);
      vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS + 1);
      f.mockImplementation((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
      expect(await publicDownloadTarget(A, f)).toBe(dmg(A)); // stale
      vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS); // the rest is over — still no fresh answer
      f.mockImplementation((async () => ok(dmg(A, 'newbuild99'))) as unknown as typeof fetch);
      expect(await publicDownloadTarget(A, f)).toBe(dmg(A, 'newbuild99')); // the refresh asked again and replaced the stale one
      expect(f).toHaveBeenCalledTimes(3);
    });

    it('a bucket that never gave a good answer still gets null (the 502) — there is nothing stale to serve', async () => {
      const f = fakeFetch(async () => { throw new Error('boom'); });
      expect(await publicDownloadTarget(A, f)).toBeNull();
      vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
      expect(await publicDownloadTarget(A, f)).toBeNull();
    });

    it('the stale url is bounded: older than DOWNLOAD_STALE_MAX_MS it is not served any more (null)', async () => {
      const f = fakeFetch(async () => ok(dmg(A)));
      await publicDownloadTarget(A, f);
      f.mockImplementation((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
      vi.advanceTimersByTime(DOWNLOAD_STALE_MAX_MS - 1_000);
      expect(await publicDownloadTarget(A, f)).toBe(dmg(A)); // still young enough
      vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS + 2_000); // past the bound
      expect(await publicDownloadTarget(A, f)).toBeNull();
    });

    it('an explicit refusal is not an outage: the manifest was READ and its url is not ours → null, and nothing stale is served afterwards either', async () => {
      const f = fakeFetch(async () => ok(dmg(A)));
      await publicDownloadTarget(A, f);
      vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS + 1);
      f.mockImplementation((async () => ok('https://evil.example/x.dmg')) as unknown as typeof fetch);
      expect(await publicDownloadTarget(A, f)).toBeNull(); // not the stale url
      vi.advanceTimersByTime(DOWNLOAD_FAILURE_MEMORY_MS);
      f.mockImplementation((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
      expect(await publicDownloadTarget(A, f)).toBeNull(); // the refused read dropped the stale answer
    });

    it('is per bucket: A has a stale url, B never had a good answer — both refresh and fail → A serves its own, B gets null', async () => {
      const f = fakeFetch(async (url) => ok(url.includes(`/${B}/`) ? dmg(B) : dmg(A)));
      await publicDownloadTarget(A, f);
      vi.advanceTimersByTime(DOWNLOAD_TARGET_TTL_MS + 1);
      f.mockImplementation((async () => { throw new Error('boom'); }) as unknown as typeof fetch);
      expect(await publicDownloadTarget(A, f)).toBe(dmg(A));
      expect(await publicDownloadTarget(B, f)).toBeNull(); // B has nothing — and A's url is never handed to B
    });
  });
});
