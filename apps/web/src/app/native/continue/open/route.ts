import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { getServerSession } from '@/lib/db/server';
import { CONTINUE_PATH, continueQuery, parseContinueStart, startParamsFrom } from '@/lib/auth/desktop-continue';
import { issueContinueCode } from '@/lib/auth/desktop-continue-issue';

// story 4712 AC4 (c) — [열기] as a plain form POST (PO 10-17: «[열기]를 JS 없이도 동작하는 평범한 form 제출로»). Walk of c1372ee9c: pressed within ~2 s of the page
// showing, the button did nothing — its click handler is not there until the page has hydrated. A form posts without any script: the server makes the
// one-time code (the same `issueContinueCode` as /api/desktop/continue — the limit, the closed table, the fixed return uri, the PKCE challenge) and
// answers 303 to the return page where a person taps once more (Safari's gesture window and the scheme-hop-only-from-a-tap contract: AC4 (d) keeps two taps).
//   · the page itself still makes no code — only this POST does (Kadir v2 ②); no GET handler;
//   · Origin is required (none at all is refused), another site's is refused — and a cross-site form POST carries no session cookie anyway;
//   · who the code is for comes from the SESSION; the form\'s fields are only the app\'s four start parameters (anything else is not read);
//   · a failure is never a bare error page: it goes back to the confirm page with `failed=1` (the page says so and the button is there again).
const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } as const;
const see = (to: string) => new NextResponse(null, { status: 303, headers: { ...NO_STORE, Location: to } });

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('Origin')) return NextResponse.json({ error: { code: 'CSRF_FORBIDDEN', message: 'CSRF_FORBIDDEN' } }, { status: 403, headers: NO_STORE });
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError;

  const raw: Record<string, unknown> = {};
  try {
    const form = await request.formData();
    // a field given twice, or a file, is off (not «absent») — `startParamsFrom` refuses what is not ONE string
    for (const k of new Set([...form.keys()])) {
      const all = form.getAll(k);
      raw[k] = all.length === 1 ? all[0] : all;
    }
  } catch { return see(CONTINUE_PATH); }
  const q = startParamsFrom(raw);
  const start = q && parseContinueStart(q);
  if (!start) return see(CONTINUE_PATH); // the page says «open this from the app»

  const here = `${CONTINUE_PATH}?${continueQuery(start)}`;
  const session = await getServerSession();
  if (!session) return see(`/login?next=${encodeURIComponent(here)}`);

  const issued = await issueContinueCode(session.user_id, start);
  if (!issued.ok) return see(`${here}&failed=1`);
  return see(issued.url);
}
