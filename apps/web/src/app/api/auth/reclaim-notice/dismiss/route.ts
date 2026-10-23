import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/auth/reclaim-notice/dismiss — story 4725 (decision 2).
 *
 * The person closes the «what was cut when your mailbox was proved» notice: BE `POST /api/v2/auth/reclaim-notice/dismiss` clears the server's
 * «show once» mark of the CALLER's own account (no id travels; a personal API key or an agent key is 403 there). Passed through with the session
 * cookie like the other authenticated auth routes — after the same-origin check the other cookie-authenticated state-changing auth routes make
 * (a forged cross-site POST must not use up the «once»).
 */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;
  return proxyToFastapi(request, '/api/v2/auth/reclaim-notice/dismiss');
}
