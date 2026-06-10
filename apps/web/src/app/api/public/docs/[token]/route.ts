import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ token: string }> };

/**
 * Public, unauthenticated proxy — resolve a shared doc by opaque token (b1574f5a).
 * Staleness-immune: forwards directly to the BE (no storage-api repo, so a stale
 * bundled dist can't break it), wraps the raw success body in the `{ data }` envelope
 * the viewer reads, and passes invalid/revoked/expired (404/410) through verbatim —
 * the doc's existence is never disclosed.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { token } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/public/docs/${token}`, { public: true });
}
