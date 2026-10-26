// 4763 follow-up (Kadir's lens on 5238, the PO's call: a small process cache) — the public download door (/desktop/get/macos) reads the GCS manifest for every logged-out request, with no cache and no
// time limit, and the proxy has no rate limit on public paths. This holds the ONE answer it needs — the checked download url — in this process for a short while, joins requests that arrive while a read is
// in flight into that one read, and gives the read a time limit. Only a GOOD answer is kept (a failure is never cached: the next request asks again); the answer and the read in flight are kept PER BUCKET
// (a changed setting is never served the old bucket's file, and two buckets reading at once cannot overwrite each other); a new dmg is served at most DOWNLOAD_TARGET_TTL_MS late. The TTL is measured on the
// monotonic `performance.now()`, not the wall clock (a clock set back must not bring an expired answer back). The logged-in card's manifest route is not touched (it stays «past any front cache», no-store).
import { fetchDesktopDownloadManifest, ourDownloadUrl } from '@/lib/desktop-downloads';

export const DOWNLOAD_TARGET_TTL_MS = 45_000;
export const DOWNLOAD_FETCH_TIMEOUT_MS = 5_000;

const answers = new Map<string, { target: string; at: number }>();
const reading = new Map<string, Promise<string | null>>();

/** for tests: forget every answer and every read in flight */
export function clearDownloadTargetCache(): void {
  answers.clear();
  reading.clear();
}

const withTimeout = (fetchImpl: typeof fetch): typeof fetch => (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(DOWNLOAD_FETCH_TIMEOUT_MS) });

async function readTarget(bucket: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(await fetchDesktopDownloadManifest(withTimeout(fetchImpl), bucket));
    return ourDownloadUrl(typeof manifest === 'object' && manifest !== null ? (manifest as { url?: unknown }).url : undefined, bucket);
  } catch (err) {
    console.error('desktop_downloads.public_redirect_unavailable', err instanceof Error ? err.name : 'unknown'); // the error NAME only (Kadir): a message may carry a url or a token
    return null;
  }
}

/** The checked download url inside `bucket`, or null (unreadable · not ours · not JSON · timed out). */
export function publicDownloadTarget(bucket: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const kept = answers.get(bucket);
  if (kept && performance.now() - kept.at < DOWNLOAD_TARGET_TTL_MS) return Promise.resolve(kept.target);
  const running = reading.get(bucket);
  if (running) return running;
  const promise: Promise<string | null> = readTarget(bucket, fetchImpl)
    .then((target) => {
      if (target) answers.set(bucket, { target, at: performance.now() });
      else answers.delete(bucket); // nothing bad is kept — and an expired answer is not left behind
      return target;
    })
    .finally(() => {
      if (reading.get(bucket) === promise) reading.delete(bucket);
    });
  reading.set(bucket, promise);
  return promise;
}
