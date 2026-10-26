// story #4763 (PO 10-26) — the first screen's «Mac 앱 받기» for a person with no account: the file itself, no sign-up in between. The card's manifest route (/desktop/downloads/macos.json) stays
// behind a session; this one is the only public door to the download, and it gives nothing but a redirect: no body, never the manifest (no sha256 · build · version) — the target is the manifest's
// own `url`, accepted only if it is https on storage.googleapis.com INSIDE the configured bucket (`ourDownloadUrl`, the card's check), and the whole thing exists only where the download does
// (`DESKTOP_DOWNLOAD_ENABLED` — the same server switch as /desktop; off → 404, the manifest is not even read). proxy.ts lists exactly this path (PUBLIC_EXACT), not a prefix.
import { NextResponse } from 'next/server';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { desktopDownloadBucket } from '@/lib/desktop-downloads';
import { publicDownloadTarget } from '@/lib/desktop-download-target';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
  if (!isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)) return new NextResponse(null, { status: 404, headers: NO_STORE });
  const bucket = desktopDownloadBucket();
  if (!bucket) return new NextResponse(null, { status: 502, headers: NO_STORE }); // switch on, no bucket named: nothing is ours — and the manifest is not read
  // the manifest read — kept in this process for a short while, joined while in flight, with a time limit (lib/desktop-download-target.ts · 4763 follow-up); it logs a failure by the error name only
  const target = await publicDownloadTarget(bucket);
  if (!target) return new NextResponse(null, { status: 502, headers: NO_STORE });
  return new NextResponse(null, { status: 302, headers: { ...NO_STORE, Location: target } });
}
