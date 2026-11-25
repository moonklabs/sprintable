import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story 5023 (d) — POST /api/v2/org-members/{id}/password-reset-link: an OWNER of a workspace server (no mail) hands a member a password-reset link. The answer is the server's own (the link is a secret for 30 minutes:
// it is passed on as it is, never kept here). Nothing is read from the request body or added to it.
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const upstream = await proxyToFastapiWithParams(request, '/api/v2/org-members/[id]/password-reset-link', { id });
  // the link is a secret for its minutes: the proxy passes on only a few response headers, and `Cache-Control` is not one of them — it is set here, on the answer that carries the link and on a refusal alike (codex pass 1)
  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
