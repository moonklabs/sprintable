// [SID:4619] AC2 — the /desktop card's download: the app the crew uses («Sprintable Dev Setup», the Electron DMG), not the
// old Tauri app. Its manifest is not written here: sprintable-mobile `desktop-electron/scripts/publish-dev-setup.mjs` (the PO
// runs it on the Mac that built the DMG) checks the app (Developer ID · build) and puts it in the public bucket at
// macos-electron/latest/manifest.json — this only relays that body as it is.
// The old Tauri manifest (desktop-updates.ts · /desktop/updates/macos.json) stays as it is: installed old apps update from it.

// story 4696 (PO 10-15): the bucket is the SERVER's setting (`DESKTOP_DOWNLOAD_BUCKET`), never a constant here — a constant dev bucket
// would send a prod customer to the dev app (which talks to the dev server) the moment the prod switch is turned on. No default: a
// deployment that sets none (prod today) has no download — the card says «지금은 받을 수 없어요» — and can never fall back to dev's.
export const DESKTOP_DOWNLOAD_BUCKET_ENV = 'DESKTOP_DOWNLOAD_BUCKET';
/** the response header the manifest route tells the card its bucket in (the card is a client component: it cannot read the server env) */
export const DESKTOP_DOWNLOAD_BUCKET_HEADER = 'x-desktop-download-bucket';
const BUCKET_NAME = /^[a-z0-9][a-z0-9_-]{2,62}$/;

/** the configured bucket's name, or null (unset · not a plain bucket name — a «/» or a «.» could point the link elsewhere) */
export function desktopDownloadBucket(value: string | undefined = process.env[DESKTOP_DOWNLOAD_BUCKET_ENV]): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return BUCKET_NAME.test(v) ? v : null;
}

const manifestUrlFor = (bucket: string): string => `https://storage.googleapis.com/${bucket}/macos-electron/latest/manifest.json`;

export class DesktopDownloadUnavailableError extends Error {}

/** The fields the card reads (publish-dev-setup.mjs manifestFor). */
export interface DesktopDownloadManifest {
  product: string;
  version: string;
  build: string;
  url: string;
  sha256: string;
  pub_date: string;
}

/** [SID:4619 · Kadir 5004 후속 ①] the one place a download may come from — the bucket publish-dev-setup.mjs writes to (4696: the configured one) */
const DOWNLOAD_HOST = 'storage.googleapis.com';

/**
 * The manifest's url as the card may link it, or null. The manifest is relayed as it is, so its url is not ours until checked:
 * only https on storage.googleapis.com inside our bucket (the trailing slash — a bucket whose name only starts the same is
 * another bucket). The check is on the parsed URL (a «..», an encoded one, a user-info part or a port are resolved first), and
 * the parsed href is what gets linked.
 */
export function ourDownloadUrl(url: unknown, bucket: string | null | undefined): string | null {
  if (typeof url !== 'string' || typeof bucket !== 'string' || !BUCKET_NAME.test(bucket)) return null; // no bucket named = nothing is ours
  const DOWNLOAD_PATH_PREFIX = `/${bucket}/`;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.host !== DOWNLOAD_HOST || u.username || u.password) return null;
  return u.pathname.startsWith(DOWNLOAD_PATH_PREFIX) && u.pathname.length > DOWNLOAD_PATH_PREFIX.length ? u.href : null;
}

/** The GCS manifest body as it is (no parse · no rebuild), past any front cache (the same cache-busting as desktop-updates.ts). */
export async function fetchDesktopDownloadManifest(fetchImpl: typeof fetch = fetch, bucket: string | null = desktopDownloadBucket()): Promise<string> {
  // no bucket configured (prod today): nothing to read — never the dev one
  if (!bucket) throw new DesktopDownloadUnavailableError('no download bucket is configured (DESKTOP_DOWNLOAD_BUCKET)');
  const nonce = Math.random().toString(36).slice(2);
  const res = await fetchImpl(`${manifestUrlFor(bucket)}?_t=${Date.now()}-${nonce}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new DesktopDownloadUnavailableError(`GCS download manifest fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
