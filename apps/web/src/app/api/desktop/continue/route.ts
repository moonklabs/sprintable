import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { getServerSession } from '@/lib/db/server';
import { expectedReturnUri } from '@/lib/auth/oauth-callback-mode';
import { continueReturnPath, parseContinueStart } from '@/lib/auth/desktop-continue';
import { overContinueLimit } from '@/lib/auth/desktop-continue-limit';
import { BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS } from '@/lib/backend-signal';
import { backendFetch } from '@/lib/backend-fetch';

// story 4712 — [열기]: the signed-in person lets the Mac app on THIS computer take their account. The only place the one-time hand-off code
// is made for this path (the page itself makes none). It calls the same internal issue the Google / Apple callback calls — no new way to
// make a session. The code is for the challenge the app sent (PKCE), valid 120 s, once; the app proves it with its own verifier.
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
const APP_LINK_ORIGIN = () => process.env['MOBILE_APP_LINK_ORIGIN'] ?? 'https://dev-app.sprintable.ai';

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
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') q.set(k, v);
  // Kadir v2 ①: where the code may go is a closed table; off the table → refused, the issue is never called
  const start = parseContinueStart(q);
  if (!start) return fail(400, 'BAD_START');

  if (overContinueLimit(session.user_id, Date.now())) return fail(429, 'RATE_LIMITED');

  const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
  const issueRes = await backendFetch(`${FASTAPI_URL()}/api/v2/internal/auth/oauth-handoff/issue`, {
    // 한 번 쓰는 로그인 코드 발급(story #4320 같은 꼴) — 브라우저가 끊어도 끝까지, 시간 제한만
    timeLimitOnly: true, timeoutMs: BFF_BACKEND_EXTERNAL_CHAIN_TIMEOUT_MS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}) },
    body: JSON.stringify({
      user_id: session.user_id,
      code_challenge: start.challenge,
      callback_mode: 'custom_scheme',
      return_uri: expectedReturnUri('custom_scheme', APP_LINK_ORIGIN()),
    }),
  }).catch(() => null);
  if (!issueRes || !issueRes.ok) return fail(502, 'ISSUE_FAILED');
  const issued = (await issueRes.json().catch(() => null)) as { code?: unknown } | null;
  if (!issued || typeof issued.code !== 'string' || issued.code.length === 0) return fail(502, 'ISSUE_FAILED');

  return NextResponse.json({ data: { url: continueReturnPath(issued.code, start.returnApp) } }, { headers: NO_STORE });
}
