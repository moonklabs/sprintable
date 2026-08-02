import { jwtVerify } from 'jose';
import { NextResponse, type NextRequest } from 'next/server';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { SESSION_EXPIRED_REASON } from '@/lib/auth/session-redirect';
import { isRecentlySuperseded } from '@/lib/auth/switch-epoch';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES, RETIRED_RESOURCES } from '@/lib/legacy-resource-tables';
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
  // story #2405 — 사용자용 연결 안내(채용 완료 화면 ②「깨우기」 카드가 이리로 링크한다).
  // 위와 같은 이유로 공개여야 한다 — 링크를 공유받은 사람이 로그인 벽에 막히면 안 된다.
  '/connect-guide.txt',
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

// story #2393(2026-08-01) — MIGRATED_RESOURCES/RENAMED_RESOURCES/RETIRED_RESOURCES를
// `lib/legacy-resource-tables.ts`로 옮겼다(위에서 import). route-resolve.ts의
// RESERVED_FIRST_SEGMENTS가 이 표들에서 직접 파생해야 하는데, route-resolve.ts는 proxy.ts에
// 이미 import되는 쪽(fetchResolve 등)이라 proxy.ts가 반대로 route-resolve.ts를 import하면
// 순환참조가 된다 — 이 표들을 어느 쪽도 import하지 않는 leaf 모듈로 빼서 그 순환을 피했다.
// 아래 재수출은 기존 소비처(`scripts/verify-no-orphan-resource-routes.ts`가 `../src/proxy`
// 에서 가져오던 경로)가 안 깨지게 유지한다 — 값은 여전히 legacy-resource-tables.ts가 SSOT다.
export { RENAMED_RESOURCES, RETIRED_RESOURCES };

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
  // orgId조차 없으면(토큰 자체가 org_id를 못 실은 예외적 경우) 개입할 근거가 없어 그대로 통과
  // (Next 자체 404) — verifyAccessToken 통과 후 이론상 가능하나 실사용 재현 없음, story #2212
  // 스코프 밖(그 경우엔 org조차 모르니 org-briefing으로도 못 보낸다).
  if (!orgId) return null;
  // story #2212 — 여기서 그냥 null(→ Next 404)을 주던 것이 결함이었다. "프로젝트를 못 정했다"는
  // 사고가 아니라 코드 주석에 그대로 선언된 설계였지만("해소 불가면 null"), 그 선택 자체가
  // dead-end라 처방 대상이다. org는 확定됐으니 org-briefing(프로젝트 불필요 페이지)으로 보내고
  // 원래 목적지를 ?next=로 보존 — use-unified-switcher.ts의 switchProject/switchOrgAndProject가
  // 이 next를 읽어 프로젝트 선택 직후 그리로 돌려보낸다("고르면 여기로 돌아온다").
  // ⛔되돌이 방지(오르테가 지적) — 이미 이 왕복을 한 번 거쳐온 요청(RESOLVE_RETRY_PARAM 존재)이
  // 또 실패하면 다시 org-briefing으로 튕기지 않는다 — 프로젝트를 골라도 안 되는 것이면 무한
  // 왕복 대신 정직하게 멈춘다(Next 자체 404).
  if (!projectId) {
    if (request.nextUrl.searchParams.has(RESOLVE_RETRY_PARAM)) return null;
    return redirectToProjectPicker(request, pathname);
  }

  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  const slugs = await resolveLegacyResourcePath(fastapiUrl, orgId, projectId, accessToken);
  // org/project는 둘 다 확定됐는데 BE 해소만 실패한 경우(예: 그 project가 삭제/접근철회)도
  // 같은 안내로 보낸다(AC4: "404가 맞는 경우에도 다음 발이 붙는다") — 단, 이것도 되돌이 방지 적용.
  if (!slugs) {
    if (request.nextUrl.searchParams.has(RESOLVE_RETRY_PARAM)) return null;
    return redirectToProjectPicker(request, pathname);
  }

  const rest = pathname.slice(`/${resourceName}`.length); // '' | '/{sub}' | '/{sub}/{sub2}'
  const url = request.nextUrl.clone();
  url.pathname = `/${slugs.orgSlug}/${slugs.projectSlug}/${resourceName}${rest}`;
  url.searchParams.delete(RESOLVE_RETRY_PARAM); // 성공 착지 URL에 내부 마커가 새지 않게
  return NextResponse.redirect(url, 301);
}

// story #2212 — org-briefing 왕복이 한 번 더 실패했을 때 무한 왕복을 막기 위한 내부 마커(오르테가
// 지적). redirectToProjectPicker가 next 목적지에 심고, redirectLegacyResourcePath가 "이미 한 번
// 튕겼던 요청인가"를 판별하는 데만 쓴다 — 사용자에게 노출될 일 없는(성공 시 delete) 순수 내부 신호.
const RESOLVE_RETRY_PARAM = '_prRetry';

// story #2212(오르테가 지적, open-redirect 방어) — next로 실어 보내는 값은 반드시 내부 경로여야
// 한다. 여기(생성 쪽)의 originalPathname은 항상 request.nextUrl.pathname에서 유도돼 구조적으로
// 안전하지만, 진짜 위험한 소비 지점은 use-unified-switcher.ts(그쪽은 사용자가 URL로 조작 가능한
// ?next=를 읽어 router.push한다) — 방어는 그쪽에도 동일하게 있어야 한다(양쪽 다, 한쪽만으론 뚫림).
function isSafeInternalPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function redirectToProjectPicker(request: NextRequest, originalPathname: string): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/org-briefing';
  const targetSearch = new URLSearchParams(request.nextUrl.search);
  targetSearch.set(RESOLVE_RETRY_PARAM, '1');
  const targetQuery = targetSearch.toString();
  const next = originalPathname + (targetQuery ? `?${targetQuery}` : '');
  url.search = '';
  if (isSafeInternalPath(next)) url.searchParams.set('next', next);
  return NextResponse.redirect(url, 302); // 302 — 이 목적지는 계정 상태(현재 프로젝트)에 의존, 영구 아님
}

/**
 * story 8fc51517(계층 리네이밍 B1, doc hierarchy-renaming-url-implementation-design §ⓑ) —
 * `/{ws}/{proj}/{resource}` 안의 **경로 리터럴**이 신 용어로 바뀔 때(에픽→목표 등)의 301.
 * `redirectLegacyResourcePath`(위)와 다른 관심사 — 저건 ws/proj 세그먼트 자체가 없던 옛 flat
 * URL을 org/project 재조회로 채워 넣는 것이고, 이건 ws/proj가 **이미 URL에 있으므로** 3번째
 * 세그먼트(리소스명)만 신 이름으로 교체하면 된다(org/project 재조회 fetch 불요, 훨씬 가벼움).
 * `RENAMED_RESOURCES`(이 rename표)와 `RETIRED_RESOURCES`(폐기표, id 폐기 — 아래 함수와 짝)의
 * 정의와 상세 주석은 `lib/legacy-resource-tables.ts`(위에서 import) 참조.
 */
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

function redirectRetiredResourcePath(request: NextRequest, pathname: string): NextResponse | null {
  const segments = pathname.split('/').filter(Boolean);
  const resourceName = segments[2]; // [ws]/[proj]/{resourceName}/...
  if (!resourceName) return null;
  const newName = RETIRED_RESOURCES[resourceName];
  if (!newName) return null;
  const url = request.nextUrl.clone();
  // id 등 하위 세그먼트는 «버린다» — 폐기된 리소스의 id는 후계 리소스의 id 공간과 다르므로,
  // 들고 가면 우연히 같은 id의 남의 항목이 열릴 위험이 있다(못 찾는 404보다 무겁다).
  url.pathname = '/' + segments.slice(0, 2).join('/') + '/' + newName;
  return NextResponse.redirect(url, 301);
}

// bf305fa0 멀티계정 — active 포인터(switch가 set). 없으면 단일계정(back-compat).
const ACTIVE_ACCOUNT_COOKIE = 'sp_active_account';
// account-vault.ts와 동일 값 — 그 모듈은 next/headers(cookies())를 임포트해 middleware/proxy
// 런타임에서 못 씀(ACTIVE_ACCOUNT_COOKIE와 동일 이유로 이미 로컬 재정의된 관례를 따름).
const VAULT_PREFIX = 'sp_acct_rt_';

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

// #2124 ㉯(선생님 실측·오르테가군 판정 2026-07-27): 지우는 것은 "이 토큰은 진짜 죽었다"(백엔드가
// 명시 401로 거부)일 때만이어야 한다 — 5xx/네트워크에러/타임아웃은 "확인 못 했다"이지 "죽었다"가
// 아니다. 예전엔 `!res.ok`(401도 429도 503도 전부 동일) + `catch`(네트워크에러도 동일)를 구분
// 없이 전부 "실패"로 뭉쳐 clearAuthCookies로 이어졌다 — 일시 장애 한 번에 멀쩡한 30일 세션이
// 영구 삭제되는 근본(㉢, dev vitest로 트리거 도달 실증·proxy.test.ts). status==401만 "invalid"
// (backend가 실제로 검사해 거부한 것 — TOKEN_REVOKED/INVALID_TOKEN/USER_NOT_FOUND 전부 401로
// 통일돼 있음, backend/app/routers/auth.py 실측)로 좁히고 나머지는 전부 "transient"로 분리한다.
type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; refreshToken: string }
  | { kind: 'invalid' } // 백엔드가 401로 명시 거부 — 이 토큰은 진짜 죽음, 지워도 안전
  | { kind: 'transient' }; // 5xx·429·네트워크에러·타임아웃·응답 파싱 실패 — 죽었는지 모름, 지우면 안 됨

async function refreshWithToken(rt: string): Promise<RefreshOutcome> {
  const fastapiUrl = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
  try {
    const res = await fetch(`${fastapiUrl}/api/v2/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (res.status === 401) return { kind: 'invalid' };
    if (!res.ok) return { kind: 'transient' };
    const json = await res.json() as { data?: { access_token: string; refresh_token: string } };
    const tokens = json.data;
    // 200인데 payload가 기대 shape가 아닌 것도 "토큰이 죽었다"는 신호가 아니다(예: 응답 파싱
    // 실패·백엔드 계약 드리프트) — transient로 취급해 재시도 여지를 남긴다.
    if (!tokens?.access_token || !tokens?.refresh_token) return { kind: 'transient' };
    return { kind: 'ok', accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
  } catch {
    return { kind: 'transient' };
  }
}

async function tryRefreshViaFastapi(request: NextRequest): Promise<RefreshOutcome> {
  const rt = request.cookies.get(SP_RT_COOKIE)?.value;
  let primaryOutcome: RefreshOutcome = { kind: 'invalid' }; // sp_rt 자체가 없음 = 시도할 것도 없음
  if (rt) {
    primaryOutcome = await refreshWithToken(rt);
    if (primaryOutcome.kind === 'ok') return primaryOutcome;
  }

  // #2124 ㉮(선생님 실측 2026-07-27): 멀티계정 switch/add-account 後 clearAuthCookies가 sp_at/sp_rt만
  // 지우고 금고(sp_acct_rt_*)·sp_active_account는 안 건드리는 ㉢과 맞물려, sp_rt가 없거나 죽어도
  // **활성 계정의 금고 토큰은 여전히 살아있는** 상태가 남는다 — 그런데 여기가 지금까지 그 금고의
  // 존재 자체를 몰랐다(proxy.ts 전체 grep 0건이었던 자리). "매일 방문해도 늘 로그아웃"의 근본 —
  // 이미 그 상태에 빠진 사용자를 여기서 꺼낸다.
  // ⛔경계(오르테가군 지시, 표면 확장 금지):
  //   · sp_active_account가 가리키는 **그 계정의** 금고 항목만 본다(금고에 있는 아무 토큰이나 X).
  //   · 쿠키 값을 그대로 신뢰하지 않는다 — refreshWithToken이 백엔드 검증을 그대로 거친다(추가
  //     신뢰 경계 확장 0, 기존 rotate 경로 재사용).
  //   · sp_active_account가 가리키는 계정이 금고에 없으면 조용히 다른 걸로 넘어가지 않고 기존
  //     동작(폴백의 폴백 없음 — primaryOutcome 그대로 반환).
  const activeAccountId = request.cookies.get(ACTIVE_ACCOUNT_COOKIE)?.value;
  if (!activeAccountId) return primaryOutcome;
  const vaultRt = request.cookies.get(`${VAULT_PREFIX}${activeAccountId}`)?.value;
  if (!vaultRt) return primaryOutcome;
  const vaultOutcome = await refreshWithToken(vaultRt);
  if (vaultOutcome.kind === 'ok') return vaultOutcome;
  // 둘 다 실패 — 어느 한쪽이라도 transient(확인 못 함)면 안전 쪽(transient)으로 합산한다.
  // 예: sp_rt는 진짜 죽었지만(invalid) 금고 시도가 마침 네트워크 에러(transient)면, 그 금고
  // 토큰이 사실 살아있었을 수도 있으므로 지우면 안 된다 — "덜 확信한 쪽"을 최종 판정으로.
  if (primaryOutcome.kind === 'transient' || vaultOutcome.kind === 'transient') return { kind: 'transient' };
  return { kind: 'invalid' };
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

// story e5225c0a(P0)+#2124 ㉯: refresh 시도 후 세션을 못 살렸을 때의 공통 응답. `clearCookies`=true
// (RefreshOutcome.kind === 'invalid' — 백엔드가 401로 명시 거부한 경우만)일 때만 clearAuthCookies
// 호출. 'transient'(5xx·네트워크에러 등, 죽었는지 확인 못 함)는 쿠키를 보존해 다음 방문에 다시
// 시도할 여지를 남긴다(㉢ 수정 — 일시 장애로 멀쩡한 세션이 영구 삭제되던 것). refreshMatchesActive
// =false(RC2, superseded 계정의 늦은 refresh)는 refresh 자체는 성공이므로 쿠키를 그대로 둔다 —
// 이 세 실패 사유를 여기서 한 번만 구분해 양쪽 호출부의 분기를 통일한다.
function handleUnauthenticated(request: NextRequest, isApiPath: boolean, clearCookies: boolean): NextResponse {
  const response = isApiPath ? NextResponse.next({ request }) : loginRedirect(request);
  if (clearCookies) clearAuthCookies(response);
  return response;
}

// story #2212 — 근본원인(curl 재현으로 확定, 2026-07-27): accessToken이 없거나(만료 등) 무효라
// refresh를 타는 두 분기가, refresh 성공 후 **바로 `NextResponse.next()`로 원 pathname을 그대로
// 통과**시켰다. bare flat 링크(`/board` 등)는 그 pathname 자체엔 대응하는 페이지가 없어(오직
// `/{ws}/{proj}/board`만 존재) redirectLegacyResourcePath를 거치지 못한 채 Next 라우터가 즉시
// 404 — 새로 발급된 토큰은 org_id/project_id 둘 다 정상인데도(다음 요청은 정상 301) 이 요청
// 자체는 구제되지 않았다. "세션 만료 후 재로그인 직후 첫 진입만 404, 재진입은 정상"이라는 선생님
// 재현과 정확히 일치(curl: corrupt sp_at+valid sp_rt → 새 토큰 발급되지만 응답은 404 · 그 새
// 토큰으로 재요청 → 301 정상). 고침: refresh 성공 시에도 그 새 토큰으로 이 요청 자체를
// resolveAndRespond까지 마저 태운다(API 경로는 라우트 핸들러가 직접 인증하므로 제외 — 기존 그대로).
async function respondWithRefreshedToken(
  request: NextRequest,
  pathname: string,
  tokens: { accessToken: string; refreshToken: string },
  isApiPath: boolean,
): Promise<NextResponse> {
  const headers = buildRefreshedHeaders(request, tokens);
  const response = isApiPath
    ? NextResponse.next({ request: { headers } })
    : await (async () => {
        const freshClaims = await verifyAccessToken(tokens.accessToken);
        return freshClaims
          ? resolveAndRespond(request, pathname, tokens.accessToken, freshClaims, headers)
          : NextResponse.next({ request: { headers } });
      })();
  applyTokenCookies(response, tokens.accessToken, tokens.refreshToken);
  return response;
}

// story a539c649/8fc51517/#2212 — 유효한 accessToken이 있을 때(원 요청이든, 방금 refresh로
// 받은 것이든) 실제로 응답을 만드는 본체. 두 호출부(정상 경로·refresh-직후 경로)가 완전히
// 같은 해소 순서를 타야 #2212 같은 우회가 다시 안 생긴다 — 로직을 여기 하나로 모은다.
async function resolveAndRespond(
  request: NextRequest,
  pathname: string,
  accessToken: string,
  claims: { exp?: number },
  baseHeaders: Headers,
): Promise<NextResponse> {
  // Proactive refresh if expiring within 5 minutes.
  // AC3: x-pathname 주입 — (authenticated)/layout 이 /me 401 시 next 보존 redirect 에 사용(server component
  // 는 현재 경로를 직접 못 읽음).
  const now = Math.floor(Date.now() / 1000);
  const fwdHeaders = new Headers(baseHeaders);
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

  // story #2378 — 폐기된 리소스(RETIRED_RESOURCES). rename과 달리 id를 버리고 후계 리소스의
  // 목록 루트로만 보낸다(위 redirectRetiredResourcePath 주석 참조 — id 공간이 다른데 그대로
  // 옮기면 우연히 같은 id의 남의 항목이 열릴 수 있다).
  const retiredResourceRedirect = redirectRetiredResourcePath(request, pathname);
  if (retiredResourceRedirect) return retiredResourceRedirect;

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
    const outcome = await tryRefreshViaFastapi(request);
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 현 active 세션 유지. transient/invalid는
    // 이 프로액티브 갱신에서 아무것도 안 함(기존 access token이 아직 유효해 이 요청 자체는
    // 문제 없음 — 실패해도 clearAuthCookies 대상 아님, 다음 요청이 다시 시도).
    if (outcome.kind === 'ok' && (await refreshMatchesActive(request, outcome.accessToken))) {
      applyTokenCookies(response, outcome.accessToken, outcome.refreshToken);
    }
  }

  if (pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/inbox';
    return NextResponse.redirect(url);
  }

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
    const outcome = await tryRefreshViaFastapi(request);
    if (outcome.kind !== 'ok') return handleUnauthenticated(request, isApiPath, outcome.kind === 'invalid');
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지(쿠키는 유지).
    if (!(await refreshMatchesActive(request, outcome.accessToken))) {
      return handleUnauthenticated(request, isApiPath, false);
    }
    return respondWithRefreshedToken(request, pathname, outcome, isApiPath);
  }

  const claims = await verifyAccessToken(accessToken);

  if (!claims) {
    // access token invalid/expired — try refresh
    const outcome = await tryRefreshViaFastapi(request);
    if (outcome.kind !== 'ok') return handleUnauthenticated(request, isApiPath, outcome.kind === 'invalid');
    // RC2: stale refresh(다른 계정)면 적용 안 함 — 잘못된 계정으로 복귀 방지(쿠키는 유지).
    if (!(await refreshMatchesActive(request, outcome.accessToken))) {
      return handleUnauthenticated(request, isApiPath, false);
    }
    return respondWithRefreshedToken(request, pathname, outcome, isApiPath);
  }

  return resolveAndRespond(request, pathname, accessToken, claims, request.headers);
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
