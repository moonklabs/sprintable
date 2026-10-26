// story #4763 (PO 10-26) — the first screen's «Mac 앱 받기» for a person with no account: the file itself, no sign-up in between. The card's manifest route (/desktop/downloads/macos.json) stays
// behind a session; this one is the only public door to the download, and it gives nothing but a redirect: no body, never the manifest (no sha256 · build · version) — the target is the manifest's
// own `url`, accepted only if it is https on storage.googleapis.com INSIDE the configured bucket (`ourDownloadUrl`, the card's check), and the whole thing exists only where the download does
// (`DESKTOP_DOWNLOAD_ENABLED` — the same server switch as /desktop; off → 404, the manifest is not even read). proxy.ts lists exactly this path (PUBLIC_EXACT), not a prefix.
import { NextResponse } from 'next/server';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { desktopDownloadBucket, fetchDesktopDownloadManifest, ourDownloadUrl } from '@/lib/desktop-downloads';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  if (!isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  const bucket = desktopDownloadBucket();
  let target: string | null = null;
  try {
    const manifest: unknown = JSON.parse(await fetchDesktopDownloadManifest(fetch, bucket));
    target = ourDownloadUrl(typeof manifest === 'object' && manifest !== null ? (manifest as { url?: unknown }).url : undefined, bucket);
  } catch (err) {
    console.error('desktop_downloads.public_redirect_unavailable', err instanceof Error ? err.name : 'unknown');
  }
  if (!target) return new NextResponse(null, { status: 502, headers: NO_STORE });
  return new NextResponse(null, { status: 302, headers: { ...NO_STORE, Location: target } });
}
