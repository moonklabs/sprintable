// 4763 follow-up (Kadir's lens on 5238, the PO's call: a small process cache) — the public download door (/desktop/get/macos) reads the GCS manifest for every logged-out request, with no cache and no
// time limit, and the proxy has no rate limit on public paths. This holds the ONE answer it needs — the checked download url — in this process for a short while, joins requests that arrive while a read is
// in flight into that one read, and gives the read a time limit. Only a GOOD answer is kept (a failure is never cached: the next request asks again); the answer and the read in flight are kept PER BUCKET
// (a changed setting is never served the old bucket's file, and two buckets reading at once cannot overwrite each other); a new dmg is served at most DOWNLOAD_TARGET_TTL_MS late. The TTL is measured on the
// monotonic `performance.now()`, not the wall clock (a clock set back must not bring an expired answer back). A FAILED read is remembered for a short while too (DOWNLOAD_FAILURE_MEMORY_MS, per bucket): the
// joined read ties concurrency to one, not frequency — without a rest, a bucket outage turns N requests into N reads; during the rest the answer is the same 502 (no read, nothing cached as an answer).
// STALE-IF-ERROR (4763 follow-up, PO): a customer pressing «받기» at the moment of ONE failed read must not meet a 502 for everyone on this instance — when the refresh could not READ the manifest (an error ·
// a time-out · a body that is not JSON), the last checked url of that bucket (one that passed `ourDownloadUrl`) is still served, for at most DOWNLOAD_STALE_MAX_MS (the versioned dmg stays in the bucket when
// `latest` moves on); the 502 is for a bucket that never gave a good answer (or whose last one is older than that). When the manifest WAS read and its url is NOT ours, nothing stale is served (an explicit refusal,
// not an outage). The logged-in card's manifest route is not touched (it stays «past any front cache», no-store).
import { fetchDesktopDownloadManifest, ourDownloadUrl } from '@/lib/desktop-downloads';

export const DOWNLOAD_TARGET_TTL_MS = 45_000;
export const DOWNLOAD_FETCH_TIMEOUT_MS = 5_000;
export const DOWNLOAD_FAILURE_MEMORY_MS = 3_000;
export const DOWNLOAD_STALE_MAX_MS = 3_600_000;

const answers = new Map<string, { target: string; at: number }>();
const reading = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();

/** for tests: forget every answer and every read in flight */
export function clearDownloadTargetCache(): void {
  answers.clear();
  reading.clear();
  failedAt.clear();
}

const withTimeout = (fetchImpl: typeof fetch): typeof fetch => (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS) });

type Read = { kind: 'ok'; target: string } | { kind: 'unreadable' } | { kind: 'refused' };

const logUnreadable = (err: unknown): void => console.error('desktop_downloads.public_redirect_unavailable', err instanceof Error ? err.name : 'unknown'); // the error NAME only (Kadir): a message may carry a url or a token

/** `ok`: a checked url · `unreadable`: the manifest could not be read (error · time-out · not JSON) · `refused`: it was read and its url is not ours */
async function readTarget(bucket: string, fetchImpl: typeof fetch): Promise<Read> {
  let body: string;
  try {
    body = await fetchDesktopDownloadManifest(withTimeout(fetchImpl), bucket);
  } catch (err) {
    logUnreadable(err);
    return { kind: 'unreadable' };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(body);
  } catch (err) {
    logUnreadable(err);
    return { kind: 'unreadable' };
  }
  const target = ourDownloadUrl(typeof manifest === 'object' && manifest !== null ? (manifest as { url?: unknown }).url : undefined, bucket);
  return target ? { kind: 'ok', target } : { kind: 'refused' };
}

/** the last checked url of `bucket` while it is young enough to stand in for a refresh that could not read the manifest */
function staleTarget(bucket: string): string | null {
  const last = answers.get(bucket);
  return last && performance.now() - last.at < DOWNLOAD_STALE_MAX_MS ? last.target : null;
}

/** The checked download url inside `bucket` — fresh, or (when the refresh could not read the manifest) the last checked one; null when there is none (never read · refused · too old). */
export function publicDownloadTarget(bucket: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const kept = answers.get(bucket);
  if (kept && performance.now() - kept.at < DOWNLOAD_TARGET_TTL_MS) return Promise.resolve(kept.target);
  const running = reading.get(bucket);
  if (running) return running;
  const failed = failedAt.get(bucket);
  if (failed !== undefined && performance.now() - failed < DOWNLOAD_FAILURE_MEMORY_MS) return Promise.resolve(staleTarget(bucket)); // the bucket failed a moment ago: the same answer, no new read
  const promise: Promise<string | null> = readTarget(bucket, fetchImpl)
    .then((read) => {
      if (read.kind === 'ok') {
        answers.set(bucket, { target: read.target, at: performance.now() }); // (an old failure mark is older than its rest by now — nothing to clear)
        return read.target;
      }
      failedAt.set(bucket, performance.now()); // only the fact that it failed, for a moment
      if (read.kind === 'refused') {
        answers.delete(bucket); // the manifest was read and its url is not ours: nothing stale is served for an explicit refusal
        return null;
      }
      return staleTarget(bucket); // could not read: the last checked url if it is young enough (and it is NOT replaced — a failure is never kept as an answer)
    })
    .finally(() => {
      if (reading.get(bucket) === promise) reading.delete(bucket);
    });
  reading.set(bucket, promise);
  return promise;
}
