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
  // story 26170479: 세션을 만드는 공개 엔드포인트(호출 시점엔 세션이 없는 게 정상) — 누락
  // 시 위 인증가드가 보호 라우트로 오인해 /login 307(민군 축c 실측으로 발견).
  '/auth/native',
  // e-mobile-oauth-native-handoff-contract §5/§10.1 — 격리 rail consume 착지도 동일하게 세션
  // 생성 전 호출된다(/auth/native와 같은 이유, PR#2224 교훈 선제 적용).
  '/auth/oauth-handoff',
  // §10.2: App Link/Universal Link 검증파일 — OS 레벨 검증기가 인증 쿠키 없이 호출.
  '/.well-known/',
  '/apple-app-site-association',
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

// story #1998(급, 선생님 실사용 "보드가 404") — access token의 app_metadata.project_id를
// CURRENT_PROJECT_COOKIE 부재 시 fallback으로 쓴다. 근본원인: 이 쿠키는 onboarding-form.tsx·
// switch-project·switch-org 명시 액션에서만 SET되고 평범한 로그인(POST /api/auth/login)에서는
// 전혀 SET되지 않는다(grep 확認·curl 재현: 로그인 직후 쿠키잔에 sp_at/sp_rt만 있고 이 쿠키는
// 없음) — 즉 온보딩 세션이 만료/새 기기/쿠키 삭제 후 "그냥 로그인"한 리턴 유저는 전원 이 안전망이
// 무력화돼 bare 레거시 링크(board·loops·docs 등, MIGRATED_RESOURCES)가 즉시 404. JWT 자체엔
// 로그인 시점 project_id가 이미 실려있으므로(app_metadata, org_id와 동일 위치) 그걸 재사용하면
// 추가 DB조회 없이 이 갭을 메운다 — 쿠키가 있으면 쿠키 우선(명시 switch-project 결과 존중).
async function getProjectIdFromAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    const projectId = (payload['app_metadata'] as Record<string, unknown> | undefined)?.['project_id'];
    return typeof projectId === 'string' ? projectId : null;
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
  board: [],
  // story #2016: 8fc51517(B1 리네이밍)이 epics→goals 경로 리터럴을 바꾸면서 RENAMED_RESOURCES에만
  // 반영되고 여기(MIGRATED_RESOURCES)엔 신 이름 'goals'를 안 넣었다 — bare `/epics`는 이 표를 거쳐
  // `/{ws}/{proj}/epics`로 301된 뒤 redirectRenamedResourcePath가 2차로 `goals`로 다시 301하지만,
  // bare `/goals`(신 이름 그대로 오는 딥링크·북마크·검색결과)는 애초에 이 표에 키가 없어 redirectLegacyResourcePath가
  // 즉시 null 반환 → Next 자체 404. 호스트/쿠키 무관 리소스 등록 누락 실측 확認(direct Cloud Run 호스트에서
  // /board는 301 정상·/goals만 404, 동일 JWT fallback 경로 재사용).
  goals: [],
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
  // story #1998: 쿠키 우선(명시 switch-project 결과) — 없으면 JWT app_metadata.project_id로 fallback.
  const projectId = request.cookies.get(CURRENT_PROJECT_COOKIE)?.value
    ?? await getProjectIdFromAccessToken(accessToken);
  if (!orgId || !projectId) return null;

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const slugs = await resolveLegacyResourcePath(fastapiUrl, orgId, projectId, accessToken);
  if (!slugs) return null;

  const rest = pathname.slice(`/${resourceName}`.length); // '' | '/{sub}' | '/{sub}/{sub2}'
  const url = request.nextUrl.clone();
  url.pathname = `/${slugs.orgSlug}/${slugs.projectSlug}/${resourceName}${rest}`;
  return NextResponse.redirect(url, 301);
}

/**
 * story 8fc51517(계층 리네이밍 B1, doc hierarchy-renaming-url-implementation-design §ⓑ) —
 * `/{ws}/{proj}/{resource}` 안의 **경로 리터럴**이 신 용어로 바뀔 때(에픽→목표 등)의 301.
 * `redirectLegacyResourcePath`(위)와 다른 관심사 — 저건 ws/proj 세그먼트 자체가 없던 옛 flat
 * URL을 org/project 재조회로 채워 넣는 것이고, 이건 ws/proj가 **이미 URL에 있으므로** 3번째
 * 세그먼트(리소스명)만 신 이름으로 교체하면 된다(org/project 재조회 fetch 불요, 훨씬 가벼움).
 */
const RENAMED_RESOURCES: Record<string, string> = {
  epics: 'goals',
};

function redirectRenamedResourcePath(request: NextRequest, pathname: string): NextResponse | null {
  const segments = pathname.split('/').filter(Boolean);
  const resourceName = segments[2]; // [ws]/[proj]/{resourceName}/...
  if (!resourceName) return null;
  const newName = RENAMED_RESOURCES[resourceName];
  if (!newName) return null;
  const url = request.nextUrl.clone();
  segments[2] = newName;
  url.pathname = '/' + segments.join('/');
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

// story cd10e123(P0) 근본 수정 — AC1(551bbbee)이 만든 single-flight in-memory dedupe(아래 옛
// singleFlightRefresh)는 Cloud Run 멀티인스턴스(prod maxScale=10)에서 인스턴스 간 공유가 안 돼
// 무의미했다: 하드리프레시의 병렬 인증요청이 다른 인스턴스로 라우팅되면 각자 독립 Map으로
// 같은 refresh_token을 rotate 시도 → 원자적 single-use rotation(e5225c0a)에 의해 두 번째
// 인스턴스는 TOKEN_REVOKED 401 → clearAuthCookies() → 세션 살아있는데 강제 로그아웃.
//
// 근본 fix는 BE로 옮겼다 — `/api/v2/auth/refresh`가 이제 grace-window(기본 5s) 내 재사용된
// 토큰에 한해 하드 401 대신 독립적인 새 rotation을 fork 발급한다(PR #2377). dedupe가 인스턴스
// 경계와 무관하게 필요 없어진 것 — FE는 그냥 매 요청마다 직접 refresh를 호출하면 된다(아래).

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
// (tryRefreshViaFastapi 자체가 null — BE 401/rotation 실패)일 때만 clearAuthCookies 호출.
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
    const tokens = await tryRefreshViaFastapi(request);
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
    const tokens = await tryRefreshViaFastapi(request);
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

  // story 8fc51517 — [ws]/[proj]/{resource} 경로 리터럴 rename(에픽→목표 등). org/project는
  // 이미 URL에 있으므로 fetch 없이 순수 문자열 치환(legacyResourceRedirect보다 가벼움).
  const renamedResourceRedirect = redirectRenamedResourcePath(request, pathname);
  if (renamedResourceRedirect) return renamedResourceRedirect;

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
    const tokens = await tryRefreshViaFastapi(request);
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
  // story #2039 AC3 (2차 발견) — `pathname`은 WHATWG URL 표준대로 비ASCII 세그먼트를 항상
  // percent-encoded로 준다(`장사왕` → `%EC%9E%A5%EC%82%AC%EC%99%95`, 원문 유니코드로 넣어도
  // 동일). 그 인코딩된 문자열을 그대로 fetchResolve에 넘기면 URLSearchParams가 `%`를 다시
  // `%25`로 인코딩해 **이중 인코딩**된 쿼리스트링이 나간다 — 백엔드가 한 번만 디코드하므로
  // 여전히 `%EC%9E%A5...` 문자열로 남아 DB의 raw 한글 slug(`장사왕`)와 매칭되지 않는다(형식
  // 게이트를 없앤 이후에도 남아있던 두 번째 결함, resolve 자체는 불렸지만 조회가 실패했을
  // 것 — 원 재현 로그의 "구 링크 여전히 404"가 형식게이트 하나만으로는 완전히 안 풀렸을
  // 자리). 디코드는 세그먼트 단위로 한다(경로 구분자 `/`가 디코드로 새로 생기지 않게).
  const decodeSegment = (segment: string | undefined): string | undefined => {
    if (!segment) return segment;
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment; // 잘못된 percent-sequence — 원문 그대로(fail-safe, resolve가 not_found로 정직히 실패)
    }
  };
  const segments = pathname.split('/').filter(Boolean).map(decodeSegment) as string[];
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
  // story #2022: manifest.webmanifest(PWA manifest, story #2022 신설)가 favicon.ico와 달리
  // 이 matcher 제외 목록에 없어 인증 미들웨어에 걸려 /login 307로 리다이렉트됐다 — PWA 설치
  // 프롬프트·크롤러는 쿠키 없이 manifest를 fetch하므로 실사용 환경에서 매니페스트가 항상
  // 깨진 상태였을 것(로컬 실측으로 발견).
  // story #2026: 같은 클래스 재발 — public/fonts/*.woff2도 확장자 목록에 없어 미인증
  // 요청이 /login 307로 리다이렉트됐다(로컬 dev로 document.fonts 상태가 전부 error인 것을
  // 발견해 역추적). @font-face src fetch는 crossorigin 쿠키 미동봉 케이스가 있어 static
  // 폰트 파일은 favicon.ico와 동일하게 인증 예외가 맞다.
  //
  // PO 지적(#2026 리뷰): 같은 형태가 두 번(매니페스트·폰트) 났으니 다음(아이콘·사운드·
  // 비디오·소스맵)도 조용히 막힐 것 — 확장자를 하나씩 나열하는 대신 **정적 자산 확장자
  // 전 카테고리**를 미리 열어 같은 결함 클래스를 구조로 막는다. 전체 확장자 무조건 허용
  // (`.*\.[^/]+$`)은 하지 않는다 — 동적 세그먼트 값(문서 slug·공유 토큰 등)이 우연히
  // 점을 포함하면 인증이 우회되는 별도 위험이 생기기 때문에, 알려진 정적 자산 카테고리로
  // 범위를 한정한다. ⚠️ `.txt`/`.json`은 의도적으로 제외 — 다운로드·export류 인증 라우트가
  // 이 확장자로 응답할 수 있어(PUBLIC_EXACT가 이미 알려진 공개 .txt를 개별 처리 중) 넣으면
  // 그런 라우트의 인증을 통째로 우회시키는 자리다.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|map|pdf)$).*)',
  ],
};
