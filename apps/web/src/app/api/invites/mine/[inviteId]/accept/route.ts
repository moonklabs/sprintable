import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

const INVITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ inviteId: string }> };

/**
 * story 4711 AC4 — POST /api/invites/mine/{invite_id}/accept: the person takes one of THEIR pending invites (the `GET /api/invites/mine` list, which carries
 * no token) from inside the app. BE `POST /api/v2/invites/mine/{invite_id}/accept` decides everything (a person's own session, a proved mailbox, an invite
 * addressed to this account's e-mail, the one accept) and answers 404 with the same body for another person's id and for a missing one.
 *
 * Here: the call makes a membership, so a request from another page must not make it — an Origin header is REQUIRED (the shared check lets «no Origin and no
 * Referer» through; a form posted from another site always carries one), and it must be ours. A fixed route above `[token]`, like `mine` itself.
 */
export async function POST(request: Request, { params }: RouteParams): Promise<Response> {
  if (!request.headers.get('Origin')) {
    return NextResponse.json({ error: { code: 'CSRF_FORBIDDEN', message: 'Invalid request origin' } }, { status: 403 });
  }
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;
  const { inviteId } = await params;
  // an invite id is a UUID: anything else (a literal `..` would fold the path onto the token route) is the same 404 the BE gives a missing id
  if (!INVITE_ID.test(inviteId)) return NextResponse.json({ detail: 'Invite not found' }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/invites/mine/${encodeURIComponent(inviteId)}/accept`);
}
