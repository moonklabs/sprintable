import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { SESSION_EXPIRED_REASON } from '@/lib/auth/session-redirect';
import { isRecentlySuperseded } from '@/lib/auth/switch-epoch';

const PUBLIC_EXACT = [
  '/',
  '/llms.txt',
  '/llms-full.txt',
  '/llms-baos.txt',
  // 45a5a006: 공개 정적 문서(app 자체 온보딩 가이드, 랜딩과 내용 상이해 리다이렉트 대상 아님) —
  // 누락 시 인증 미들웨어가 보호 라우트로 오인해 /login 307(공개 문서가 로그인 뒤에 묶이는 버그).
  '/onboarding-guide.txt',
];

// Fully public paths — no token check at all
const PUBLIC_PREFIX = [
  // Auth endpoints — open by design
  '/api/auth/',
  '/api/oss/',
  '/api/webhook/',
  // Public doc share (b1574f5a) — unauthenticated token-based viewer + its data proxy
  '/api/public/',
  // UI public routes
  '/share/',
  '/login',
  '/signup',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/auth/callback',
  '/auth/login',
  '/invite',
  '/internal-dogfood',
  '/terms',
  '/privacy',
];

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

async function verifyAccessToken(token: string): Promise<{ exp?: number } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    if (payload['type'] !== 'access') return null;
    return { exp: payload.exp };
  } catch {
    return null;
  }
}

// bf305fa0 멀티계정 — active 포인터(switch가 set). 없으면 단일계정(back-compat).
const ACTIVE_ACCOUNT_COOKIE = 'sp_active_account';

/**
 * RC2(stale Set-Cookie suppression): refresh 결과를 sp_at/sp_rt 에 적용해도 되는지 판정.
 *  1) server-authoritative epoch — refreshed sub 가 최근 switch 로 superseded 된 계정이면 억제(결정적·
 *     request cookie snapshot 무관). switch 後 도착한 떠난-계정 late refresh 를 확실히 차단.
 *     switch-back(다시 active) 시엔 switch route 가 clearSuperseded 하므로 정상 refresh 는 통과(RC3 보존).
 *  2) active 포인터 일치(보조) — 포인터 있으면 sub == 포인터.
 * 포인터 없고 superseded 도 아니면 단일계정 back-compat 으로 허용.
 */
async function refreshMatchesActive(request: NextRequest, accessToken: string): Promise<boolean> {
  let sub: string | undefined;
  try {
    const { payload } = await jwtVerify(accessToken, getJwtSecretBytes());
    sub = typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return false;
  }
  if (!sub) return false;
  if (isRecentlySuperseded(sub)) return false; // RC2: switch 가 supersede 한 계정의 stale refresh 억제
  const pointer = request.cookies.get(ACTIVE_ACCOUNT_COOKIE)?.value;
  if (pointer && sub !== pointer) return false;
  return true;
}

async function tryRefreshViaFastapi(request: NextRequest): Promise<{ accessToken: string; refreshToken: string } | null> {
  const rt = request.cookies.get(SP_RT_COOKIE)?.value;
  if (!rt) return null;

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  try {
    const res = await fetch(`${fastapiUrl}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { access_token: string; refresh_token: string } };
    const tokens = json.data;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  } catch {
    return null;
  }
}

// AC1(551bbbee): single-flight refresh. refresh 는 single-use rotation(첫 건이 RT revoke)이라, 대시보드
// 동시요청이 같은 RT 로 각자 refresh 하면 첫 건만 통과·나머지 401 → 강제 로그아웃("세션 너무 짧음")이던
// 레이스를 제거. RT 기준 in-flight 1개로 dedupe(나머지는 그 promise 를 await/재사용) — 실제 refresh 호출은
// 1회라 single-use 보안 유지.
//   - **pending 동안은 시간 무관하게 그 promise 재사용**(refresh 가 10s 걸려도 1개만 — 시작-기준 grace 면
//     느린 refresh 가 grace 넘겨 pending 중 신규 refresh 시작=레이스 재발, RC HIGH 봉합).
//   - 해소(settled) 후엔 **해소 시각 기준 grace** 동안만 결과 재사용 — cookie 갱신 전 도착한 burst 꼬리
//     요청도 옛 RT 로 새 refresh 안 함.
// setTimeout 미사용(edge 런타임 post-response 실행 불확실)·size-cap lazy prune(무한증가 방지).
const REFRESH_GRACE_MS = 5_000;
type RefreshEntry = { p: Promise<{ accessToken: string; refreshToken: string } | null>; settledAt: number | null };
const inflightRefresh = new Map<string, RefreshEntry>();

function singleFlightRefresh(request: NextRequest): Promise<{ accessToken: string; refreshToken: string } | null> {
  const rt = request.cookies.get(SP_RT_COOKIE)?.value;
  if (!rt) return Promise.resolve(null);
  const now = Date.now();
  const existing = inflightRefresh.get(rt);
  // pending(settledAt===null) → 시간 무관 재사용 / settled → 해소 시각 + grace 내에서만 재사용.
  if (existing && (existing.settledAt === null || existing.settledAt + REFRESH_GRACE_MS > now)) {
    return existing.p;
  }
  const entry: RefreshEntry = { p: tryRefreshViaFastapi(request), settledAt: null };
  inflightRefresh.set(rt, entry);
  void entry.p.finally(() => { entry.settledAt = Date.now(); }); // 해소 시각 기록 → grace 시작점
  if (inflightRefresh.size > 64) { // settled + grace 지난 항목 lazy prune(pending 은 유지)
    for (const [k, v] of inflightRefresh) if (v.settledAt !== null && v.settledAt + REFRESH_GRACE_MS <= now) inflightRefresh.delete(k);
  }
  return entry.p;
}

function applyTokenCookies(
  response: NextResponse,
  accessToken: string,
  refreshToken: string,
): void {
  const base = cookieBase();
  response.cookies.set(SP_AT_COOKIE, accessToken, { ...base, maxAge: SP_AT_MAX_AGE_SECONDS });
  response.cookies.set(SP_RT_COOKIE, refreshToken, { ...base, maxAge: 30 * 24 * 60 * 60 });
}

/** Rebuild request headers with updated sp_at/sp_rt so route handlers see fresh tokens */
function buildRefreshedHeaders(
  request: NextRequest,
  tokens: { accessToken: string; refreshToken: string },
): Headers {
  const headers = new Headers(request.headers);
  const existing = headers.get('cookie') ?? '';
  const replace = (str: string, name: string, value: string) =>
    str.includes(`${name}=`)
      ? str.replace(new RegExp(`${name}=[^;]*`), `${name}=${value}`)
      : str ? `${str}; ${name}=${value}` : `${name}=${value}`;
  headers.set('cookie', replace(replace(existing, SP_AT_COOKIE, tokens.accessToken), SP_RT_COOKIE, tokens.refreshToken));
  return headers;
}

/** AC3: 인증 실패 → /login?next=<현재경로>&reason=session_expired (login 배너 + 작업 보존 복귀). */
function loginRedirect(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  const nextTarget = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', nextTarget); // searchParams.set 이 encode
  url.searchParams.set('reason', SESSION_EXPIRED_REASON);
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  const isPublicPath =
    PUBLIC_EXACT.includes(pathname) ||
    PUBLIC_PREFIX.some((prefix) => pathname.startsWith(prefix));

  if (isPublicPath) {
    return NextResponse.next({ request });
  }

  // Authenticated API routes — try token refresh but never redirect to /login
  const isApiPath = pathname.startsWith('/api/');

  // Agent API keys are for MCP/HTTP API only — block UI route access
  const authHeader = request.headers.get('Authorization');
  if (!isApiPath && authHeader?.startsWith('Bearer ')) {
    return new NextResponse(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Agent API keys cannot access UI routes' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const accessToken = request.cookies.get(SP_AT_COOKIE)?.value;

  if (!accessToken) {
    const tokens = await singleFlightRefresh(request);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지.
    if (!tokens || !(await refreshMatchesActive(request, tokens.accessToken))) {
      if (isApiPath) return NextResponse.next({ request }); // let handler return 401
      return loginRedirect(request);
    }
    const headers = buildRefreshedHeaders(request, tokens);
    const response = NextResponse.next({ request: { headers } });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  const claims = await verifyAccessToken(accessToken);

  if (!claims) {
    // access token invalid/expired — try refresh
    const tokens = await singleFlightRefresh(request);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지.
    if (!tokens || !(await refreshMatchesActive(request, tokens.accessToken))) {
      if (isApiPath) return NextResponse.next({ request }); // let handler return 401
      return loginRedirect(request);
    }
    const headers = buildRefreshedHeaders(request, tokens);
    const response = NextResponse.next({ request: { headers } });
    applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    return response;
  }

  // Proactive refresh if expiring within 5 minutes.
  // AC3: x-pathname 주입 — (authenticated)/layout 이 /me 401 시 next 보존 redirect 에 사용(server component
  // 는 현재 경로를 직접 못 읽음).
  const now = Math.floor(Date.now() / 1000);
  const fwdHeaders = new Headers(request.headers);
  fwdHeaders.set('x-pathname', pathname + request.nextUrl.search);
  const response = NextResponse.next({ request: { headers: fwdHeaders } });
  if (claims.exp !== undefined && claims.exp - now < 300) {
    const tokens = await singleFlightRefresh(request);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 현 active 세션 유지.
    if (tokens && (await refreshMatchesActive(request, tokens.accessToken))) {
      applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
    }
  }

  if (pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/inbox';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
