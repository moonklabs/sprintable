import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { SESSION_EXPIRED_REASON } from '@/lib/auth/session-redirect';
import { isRecentlySuperseded } from '@/lib/auth/switch-epoch';
import {
  fetchResolve,
  looksLikeWorkspaceSegment,
  resolveLegacyResourcePath,
  RESOLVE_CACHE_TTL_SECONDS,
  signResolveCache,
  SP_RESOLVE_CACHE_COOKIE,
  verifyResolveCache,
} from '@/lib/route-resolve';

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

// @/lib/auth-helpers.ts 의 CURRENT_PROJECT_COOKIE 와 동일 값 — 그 모듈은 next/headers(cookies())
// 를 top-level import 해 proxy.ts(별도 번들 경계)로 끌어오면 런타임 불일치 위험이 있어 리터럴만
// 복제(둘 다 이 문자열이 바뀔 일은 없음 — 서버-발급 세션 쿠키 이름).
const CURRENT_PROJECT_COOKIE = 'sprintable_current_project_id';

async function getOrgIdFromAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    const orgId = (payload['app_metadata'] as Record<string, unknown> | undefined)?.['org_id'];
    return typeof orgId === 'string' ? orgId : null;
  } catch {
    return null;
  }
}

/**
 * story a539c649 S-route-project — 이관 완료된 Project-tier 리소스 목록(flat 첫 세그먼트 →
 * 그 리소스 밑에서 project-scope 아닌 채로 존치되는 서브패스 제외 목록). 슬라이스가 리소스를
 * `/{ws}/{proj}/{resource}`로 옮길 때마다 여기 키 하나씩 추가한다(S2=docs, S3a=standup 등).
 */
const MIGRATED_RESOURCES: Record<string, string[]> = {
  docs: ['design-tokens'], // 비-project 정적 페이지, 존치
  standup: [],
  retro: [],
  loops: [],
  artifacts: [],
  mockups: [],
  sprints: [],
  storage: [],
  epics: [],
};

/**
 * story a539c649(S2 최초 도입·S3에서 리소스 파라미터화) — 옛 flat `/{resource}/*` 를
 * default(현재 org+project) 로 해소해 301. 해소 불가(로그인 직후 project 미선택 등)면 null
 * — 호출부가 개입 없이 통과시켜 Next 자체 404.
 */
async function redirectLegacyResourcePath(
  request: NextRequest,
  pathname: string,
  accessToken: string,
): Promise<NextResponse | null> {
  const segments = pathname.split('/').filter(Boolean);
  const resourceName = segments[0];
  if (!resourceName || !(resourceName in MIGRATED_RESOURCES)) return null;
  const excluded = MIGRATED_RESOURCES[resourceName] ?? [];
  if (excluded.some((sub) => pathname.startsWith(`/${resourceName}/${sub}`))) return null;

  const orgId = await getOrgIdFromAccessToken(accessToken);
  const projectId = request.cookies.get(CURRENT_PROJECT_COOKIE)?.value;
  if (!orgId || !projectId) return null;

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const slugs = await resolveLegacyResourcePath(fastapiUrl, orgId, projectId, accessToken);
  if (!slugs) return null;

  const rest = pathname.slice(`/${resourceName}`.length); // '' | '/{sub}' | '/{sub}/{sub2}'
  const url = request.nextUrl.clone();
  url.pathname = `/${slugs.orgSlug}/${slugs.projectSlug}/${resourceName}${rest}`;
  return NextResponse.redirect(url, 301);
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

// story e5225c0a(P0): refresh 최종 실패(BE 가 401 반환·rotation 실패) 시 sp_at/sp_rt 를 지운다.
// 안 지우면 30일 sp_rt 쿠키가 매 요청마다 실패한 refresh 를 재시도해 401 무한 재생산(산티아고
// prod 로그 실측: /auth/refresh 239건 중 230건 401). RC2(refreshMatchesActive=false, 다른/
// superseded 계정의 late refresh 억제)와는 다른 경우 — 그건 refresh 자체는 성공했으므로
// 쿠키를 유지해야 한다(clearAuthCookies 를 이 경우엔 호출하지 않음).
//
// ⚠️3차 재진단(산티아고 prod gcloud 실측 근본 확定): prod FE Cloud Run엔
// `NEXT_PUBLIC_COOKIE_DOMAIN=app.sprintable.ai`가 Secret Manager로 설정돼(dev엔 없음)
// cookieBase() SET 시 Domain 속성이 붙는다. bare `response.cookies.delete(name)`는 Domain
// 없이 나가 브라우저가 다른 쿠키로 취급 — 삭제가 조용히 no-op되고 죽은 sp_rt가 남아 401이
// 무한 재생산됐다(1·2차 fix가 못 잡은 진짜 근본). SET과 완전히 동일한 속성(...cookieBase())
// 으로 값 빈 문자열+maxAge=0 — 반드시 동일 쿠키로 매칭되게 한다.
function clearAuthCookies(response: NextResponse): void {
  const base = cookieBase();
  response.cookies.set(SP_AT_COOKIE, '', { ...base, maxAge: 0 });
  response.cookies.set(SP_RT_COOKIE, '', { ...base, maxAge: 0 });
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

// story e5225c0a(P0): refresh 시도 후 세션을 못 살렸을 때의 공통 응답. `refreshFailed`=true
// (singleFlightRefresh 자체가 null — BE 401/rotation 실패)일 때만 clearAuthCookies 호출.
// refreshMatchesActive=false(RC2, superseded 계정의 늦은 refresh)는 refresh 자체는 성공이므로
// 쿠키를 그대로 둔다 — 두 실패 사유를 여기서 한 번만 구분해 양쪽 호출부의 분기를 통일한다.
function handleUnauthenticated(request: NextRequest, isApiPath: boolean, refreshFailed: boolean): NextResponse {
  const response = isApiPath ? NextResponse.next({ request }) : loginRedirect(request);
  if (refreshFailed) clearAuthCookies(response);
  return response;
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
    if (!tokens) return handleUnauthenticated(request, isApiPath, true);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지(쿠키는 유지).
    if (!(await refreshMatchesActive(request, tokens.accessToken))) {
      return handleUnauthenticated(request, isApiPath, false);
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
    if (!tokens) return handleUnauthenticated(request, isApiPath, true);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지(쿠키는 유지).
    if (!(await refreshMatchesActive(request, tokens.accessToken))) {
      return handleUnauthenticated(request, isApiPath, false);
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

  // story a539c649(S2 최초·S3 일반화) — 이관 완료된 리소스(MIGRATED_RESOURCES)의 옛 flat
  // `/{resource}/*`(ws/proj 세그먼트 없음)는 목적지 페이지가 이제 없다. 여기서 잡아
  // default(현재 org+project) 해소 후 301 — 안 잡으면 사이드바 밖 외부 딥링크 호출부(알림·
  // 게이트·챗 등, 전부 bare 링크였음)가 전부 즉시 404 나던 것을 막는 안전망(PO 승인 스코프,
  // 한계=route-resolve.ts 헤더 참고).
  const legacyResourceRedirect = await redirectLegacyResourcePath(request, pathname, accessToken);
  if (legacyResourceRedirect) return legacyResourceRedirect;

  // story a539c649(S-route-project) S1 — path 위계 resolve. fwdHeaders 를 response 구성 *전에*
  // 채워야 downstream RSC/route handler 가 x-resolved-* 를 실제로 읽을 수 있다(x-pathname 과
  // 동일 관례 — response.headers.set 은 브라우저행 응답 헤더일 뿐 forwarded request 에 안 실림).
  const resolved = await resolveWorkspaceProject(request, pathname, accessToken, fwdHeaders);
  if (resolved.kind === 'redirect') return resolved.response;

  const response = NextResponse.next({ request: { headers: fwdHeaders } });
  if (resolved.kind === 'set-cache') {
    response.cookies.set(SP_RESOLVE_CACHE_COOKIE, resolved.token, { ...cookieBase(), maxAge: RESOLVE_CACHE_TTL_SECONDS });
  }

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

type ResolveWiringResult =
  | { kind: 'skip' }
  | { kind: 'set-cache'; token: string }
  | { kind: 'redirect'; response: NextResponse };

/**
 * story a539c649(S-route-project) S1 — `/{ws}/{proj}/...` path 위계 resolve. RESERVED_FIRST_
 * SEGMENTS 와 안 겹치는 첫 세그먼트에만 시도해 기존 flat 라우트 전부 무회귀 통과시킨다(오르테가군
 * 확定 스코프). flat→path 301 은 여기서 안 켠다 — 목적지 페이지가 아직 없어(S2/S3 몫) 걸면 즉시
 * 404. S1 은 미들웨어 단(캐시 hit/miss·resolve 성공/실패·구 slug 301-chase)만 증명한다.
 *
 * `fwdHeaders` 를 직접 mutate 해 downstream 으로 x-resolved-* 를 실어 보낸다(캐시 hit 이어도
 * 매 요청 동일하게 — 헤더가 fetch 왕복에 안 걸리므로 hit/miss 무관 항상 채운다).
 */
async function resolveWorkspaceProject(
  request: NextRequest,
  pathname: string,
  accessToken: string,
  fwdHeaders: Headers,
): Promise<ResolveWiringResult> {
  const segments = pathname.split('/').filter(Boolean);
  const wsSlug = segments[0];
  if (!looksLikeWorkspaceSegment(wsSlug)) return { kind: 'skip' };
  const projSlug = looksLikeWorkspaceSegment(segments[1]) ? segments[1] : undefined;

  const cached = request.cookies.get(SP_RESOLVE_CACHE_COOKIE)?.value;
  if (cached) {
    const hit = await verifyResolveCache(cached, wsSlug, projSlug);
    if (hit) {
      setResolvedHeaders(fwdHeaders, hit);
      return { kind: 'skip' }; // 캐시 hit — fetch 생략, 쿠키 재설정 불요(아직 유효)
    }
  }

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const outcome = await fetchResolve(fastapiUrl, wsSlug, projSlug, accessToken);

  if (outcome.kind === 'not_found') return { kind: 'skip' }; // resolve 실패 — 개입 없이 통과(Next 자체 404)

  if (outcome.kind === 'redirect') {
    const url = request.nextUrl.clone();
    const nextSegments = [...segments];
    if (outcome.workspace) nextSegments[0] = outcome.workspace;
    if (outcome.project && nextSegments.length > 1) nextSegments[1] = outcome.project;
    url.pathname = '/' + nextSegments.join('/');
    return { kind: 'redirect', response: NextResponse.redirect(url, 301) };
  }

  setResolvedHeaders(fwdHeaders, outcome.context);
  const token = await signResolveCache(wsSlug, projSlug, outcome.context);
  return { kind: 'set-cache', token };
}

function setResolvedHeaders(fwdHeaders: Headers, context: { orgId: string; orgRole: string; projectId?: string }): void {
  fwdHeaders.set('x-resolved-org-id', context.orgId);
  fwdHeaders.set('x-resolved-org-role', context.orgRole);
  if (context.projectId) fwdHeaders.set('x-resolved-project-id', context.projectId);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
