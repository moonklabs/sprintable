// [SID:4619] AC2 — the /desktop card's download: the app the crew uses («Sprintable Dev Setup», the Electron DMG), not the
// old Tauri app. Its manifest is not written here: sprintable-mobile `desktop-electron/scripts/publish-dev-setup.mjs` (the PO
// runs it on the Mac that built the DMG) checks the app (Developer ID · build) and puts it in the public bucket at
// macos-electron/latest/manifest.json — this only relays that body as it is.
// The old Tauri manifest (desktop-updates.ts · /desktop/updates/macos.json) stays as it is: installed old apps update from it.

const GCS_DOWNLOAD_MANIFEST_URL =
  'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos-electron/latest/manifest.json';

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

/** The GCS manifest body as it is (no parse · no rebuild), past any front cache (the same cache-busting as desktop-updates.ts). */
export async function fetchDesktopDownloadManifest(fetchImpl: typeof fetch = fetch): Promise<string> {
  const nonce = Math.random().toString(36).slice(2);
  const res = await fetchImpl(`${GCS_DOWNLOAD_MANIFEST_URL}?_t=${Date.now()}-${nonce}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new DesktopDownloadUnavailableError(`GCS download manifest fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}
