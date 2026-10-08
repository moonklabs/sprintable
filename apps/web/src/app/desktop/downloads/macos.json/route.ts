// [SID:4619] AC2 — the /desktop card's download manifest («Sprintable Dev Setup» DMG). Signed-in only (the card is on a
// signed-in page; not in proxy.ts PUBLIC_PREFIX — no app reads it without a session). Body = desktop-downloads.ts (the GCS
// manifest publish-dev-setup.mjs wrote, relayed as it is). The old Tauri updater's /desktop/updates/macos.json is separate.
import { NextResponse } from 'next/server';
import { DesktopDownloadUnavailableError, fetchDesktopDownloadManifest } from '@/lib/desktop-downloads';

export async function GET() {
  try {
    const body = await fetchDesktopDownloadManifest();
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof DesktopDownloadUnavailableError) {
      console.error('desktop_downloads.manifest_unavailable', err);
      return NextResponse.json({ error: 'manifest_unavailable' }, { status: 502 });
    }
    throw err;
  }
}
