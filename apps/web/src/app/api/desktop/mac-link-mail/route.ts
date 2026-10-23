import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';

// story #4714 AC2 — POST /api/v2/desktop/mac-link-mail proxy: the phone app's «Mac에서 열 링크를 메일로 받기». The server mails the SIGNED-IN person's
// own account address a plain link to the download page — so nothing from the caller goes on: no body, no query, no address (the closed shape is a
// structure of this route, as the server's has none to read). Where the Mac app is not offered (`isDesktopDownloadEnabled` — the one judgement the
// /desktop page itself uses) the mail is not sent either: 409 download_not_enabled, before anything reaches the server.
// A mail that leaves the system is the one side effect here, so the route keeps the sibling rule of the other side-effect POSTs (the invite accept, the
// browser continue form): **Origin is required** (none at all is refused) and another site's is refused (`verifyCsrfOrigin`) — Kadir 5152 second lens.

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('Origin')) return Response.json({ error: { code: 'CSRF_FORBIDDEN', message: 'CSRF_FORBIDDEN' } }, { status: 403 });
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;
  if (!isDesktopDownloadEnabled(process.env.DESKTOP_DOWNLOAD_ENABLED)) {
    return Response.json({ error: { code: 'download_not_enabled' } }, { status: 409 });
  }
  const url = new URL(request.url);
  url.search = '';
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return proxyToFastapi(new Request(url.toString(), { method: 'POST', headers, signal: request.signal }), '/api/v2/desktop/mac-link-mail'); // no body goes on
}
