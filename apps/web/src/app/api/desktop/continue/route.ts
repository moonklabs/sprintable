import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { getServerSession } from '@/lib/db/server';
import { parseContinueStart, startParamsFrom } from '@/lib/auth/desktop-continue';
import { issueContinueCode } from '@/lib/auth/desktop-continue-issue';

// story 4712 — [열기] (the JSON way — kept for a caller that already sends JSON; the page's own button is a plain form to /native/continue/open): the signed-in person
// lets the Mac app on THIS computer take their account. The only places the one-time hand-off code is made for this path are this and that form route
// (the page itself makes none), and both go through `issueContinueCode`. It calls the same internal issue the Google / Apple callback calls — no new way to
// make a session. The code is for the challenge the app sent (PKCE), valid 120 s, once; the app proves it with its own verifier.
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;
const fail = (status: number, code: string) => NextResponse.json({ error: { code, message: code } }, { status, headers: NO_STORE });

/** POST /api/desktop/continue {code_challenge, cc_method, callback_mode, return_app?} → {data:{url}} (the return page, with the code) */
export async function POST(request: Request): Promise<Response> {
  // Kadir v2 ②: a browser sends Origin on a same-site form / fetch POST; none at all is refused here (the shared check lets "no Origin and
  // no Referer" through — stricter on purpose for the one call that makes a login code)
  if (!request.headers.get('Origin')) return fail(403, 'CSRF_FORBIDDEN');
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const session = await getServerSession();
  if (!session) return fail(401, 'UNAUTHENTICATED');

  let raw: unknown;
  try { raw = await request.json(); } catch { return fail(400, 'BAD_REQUEST'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'BAD_REQUEST');
  // Kadir v2 ①: where the code may go is a closed table; off the table → refused, the issue is never called (a start parameter that is not one
  // string — `null`, a list — is off the table too, not «absent»)
  const q = startParamsFrom(raw as Record<string, unknown>);
  const start = q && parseContinueStart(q);
  if (!start) return fail(400, 'BAD_START');

  const issued = await issueContinueCode(session.user_id, start);
  if (!issued.ok) return fail(issued.status, issued.code);
  return NextResponse.json({ data: { url: issued.url } }, { headers: NO_STORE });
}
