import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { SIGNUP_ATTRIBUTION_COOKIE_NAMES, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { safeNextPath } from '@/lib/auth/session-redirect';
import { resolveAppUrl } from '@/services/app-url';
import { isOAuthCallbackMode, expectedReturnUri } from '@/lib/auth/oauth-callback-mode';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';
// e-mobile-oauth-native-handoff-contract §2: returnUrl = 검증된 App Link. dev/prod 도메인·서명
// association이 분리되므로(§10.2) env로 주입 — PO/인프라 lane이 prod 값 설정 책임.
const APP_LINK_ORIGIN = () => process.env['MOBILE_APP_LINK_ORIGIN'] ?? 'https://dev-app.sprintable.ai';

// 진단(2026-07-28, 모바일 구글 로그인 prod security_check_failed) — ⛔가드를 푸는 것이 아니다,
// 통과 조건은 글자 하나도 안 바뀐다. state 검증 실패가 「쿠키가 아예 안 옴(ⓐ)」과 「쿠키는
// 왔는데 값이 다름(ⓑ)」 두 서로 다른 사고로 뭉쳐 있어 처방 방향이 갈리는데 지금은 구분이
// 안 된다 — 서버 로그에만 분기해 남긴다(사용자 화면 문구는 csrf_mismatch로 동일 유지).
// ⛔state 값·쿠키 값·인증 코드는 절대 안 찍는다(길이/존재 여부만). dev의 통과 경로에도
// 성공 로그를 남겨야 "안 찍힘=미도달"과 "안 찍힘=로그 자체가 없음"이 갈린다(양성대조).
function logOauthStateCheck(
  outcome: 'missing_cookie' | 'state_mismatch' | 'ok',
  request: Request,
  provider: string,
  nativeChallenge: string | null,
  stateLen: number,
  storedStateLen: number | null,
): void {
  console.warn(
    `auth.oauth.callback.state_check outcome=${outcome} provider=${provider} ` +
    `native=${Boolean(nativeChallenge)} state_len=${stateLen} stored_state_len=${storedStateLen ?? 'null'} ` +
    `referer=${request.headers.get('referer') ?? 'null'} ua=${request.headers.get('user-agent') ?? 'null'}`,
  );
}

function cookieBase() {
  const domain = process.env['NEXT_PUBLIC_COOKIE_DOMAIN'];
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', ...(domain ? { domain } : {}) };
}

// access_token은 이 요청 안에서 방금 BE가 직접 발급한 것(공격자 입력 아님) — 서명 재검증 없이
// sub만 읽는다(§7 issue payload user_id 조달 목적, 인가 판단에 쓰지 않음).
function decodeJwtSub(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as { sub?: unknown };
    return typeof parsed.sub === 'string' ? parsed.sub : null;
  } catch {
    return null;
  }
}

type RouteParams = { params: Promise<{ provider: string }> };

// story #3118(Sign in with Apple) — Apple 공식 스펙: authorize 요청에 response_mode=
// form_post를 실으면(auth.py oauth_authorize, scope에 name/email이 있을 때 강제) Apple이
// 이 콜백 URL로 GET 리다이렉트가 아니라 application/x-www-form-urlencoded POST를 보낸다.
// code/state는 쿼리가 아니라 폼 바디에 실린다 — 그 외 로직(state 검증·BE 콜백·핸드오프)은
// GET과 완전히 동일해 handleCallback()으로 공유한다.
async function handleCallback(request: Request, provider: string, code: string | null, state: string | null) {
  const origin = resolveAppUrl(null);

  if (!['google', 'apple'].includes(provider)) {
    return NextResponse.redirect(`${origin}/login?error=invalid_provider`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_missing_params`);
  }

  // CSRF state 검증
  const cookieStore = await cookies();
  const storedState = cookieStore.get(`oauth_state_${provider}`)?.value;
  const tosAccepted = cookieStore.get(`oauth_tos_${provider}`)?.value === 'true';
  const inviteToken = cookieStore.get(`oauth_invite_token_${provider}`)?.value ?? null;
  const nextCookie = cookieStore.get(`oauth_next_${provider}`)?.value ?? null; // AC3 세션 만료 복귀
  // e-mobile-oauth-native-handoff-contract §7.4/§5 — 격리 rail(오르테가 확定, /auth/native
  // 무접촉). native OAuth-start에서만 세팅되는 challenge — 있으면 이 콜백도 native 취급.
  const nativeChallenge = cookieStore.get(`oauth_native_challenge_${provider}`)?.value ?? null;
  // story #3121 AC1 — 모바일이 OAuth 시작 시 선택한 호환 모드(계약 §2). 쿠키 부재/형식오류는
  // https로 기본 유도(BE Phase 1 확장-축소 계약과 동일 원칙 — 조용히 안 채우고 기본값 하나로
  // 수렴). 값 자체(return_uri 문자열)는 여기서 고정 매핑으로 계산 — 클라 입력을 URI로 안 믿는다.
  const nativeCallbackMode = (() => {
    const raw = cookieStore.get(`oauth_native_callback_mode_${provider}`)?.value ?? null;
    return isOAuthCallbackMode(raw) ? raw : 'https';
  })();
  // story #3122(계정 연결) — auth/link/route.ts만 세팅하는 단명 쿠키. provider가 돌려주는
  // code/state 자체엔 "로그인이냐 연결이냐" 구분이 없어(authorize 요청 파라미터가 로그인과
  // 동일하게 생겼다, 의도된 설계) 이 쿠키가 유일한 분기 신호다.
  const linkMode = cookieStore.get(`oauth_link_${provider}`)?.value === 'true';
  cookieStore.delete(`oauth_state_${provider}`);
  cookieStore.delete(`oauth_tos_${provider}`);
  cookieStore.delete(`oauth_invite_token_${provider}`);
  cookieStore.delete(`oauth_next_${provider}`);
  cookieStore.delete(`oauth_native_challenge_${provider}`);
  cookieStore.delete(`oauth_native_callback_mode_${provider}`);
  cookieStore.delete(`oauth_link_${provider}`);

  // ⛔통과 조건은 원래와 동일(storedState 존재 AND 일치) — 분기는 로그용일 뿐, 검증 자체는
  // 안 바뀐다. 두 실패 분기 다 사용자에게는 동일한 csrf_mismatch로 리다이렉트한다.
  if (!storedState) {
    logOauthStateCheck('missing_cookie', request, provider, nativeChallenge, state.length, null);
    return NextResponse.redirect(`${origin}/login?error=csrf_mismatch`);
  }
  if (storedState !== state) {
    logOauthStateCheck('state_mismatch', request, provider, nativeChallenge, state.length, storedState.length);
    return NextResponse.redirect(`${origin}/login?error=csrf_mismatch`);
  }
  logOauthStateCheck('ok', request, provider, nativeChallenge, state.length, storedState.length);

  // story #3122 — 계정 연결 콜백. 로그인 rail(/oauth/callback)과 완전히 다른 BE 엔드포인트로
  // 간다(AC4: 로그인 mint 아님 — 새 JWT를 안 받고, 기존 sp_at/sp_rt 쿠키를 그대로 둔다).
  // 링크는 "로그인된 채로" 시작한 흐름이라 이 시점 sp_at이 여전히 유효해야 한다 — 최대
  // OAUTH_STATE_EXPIRE_MINUTES(10분) 왕복 동안 세션이 끊기면(로그아웃 등) BE가 401을 주고,
  // 그대로 실패로 리다이렉트한다(별도 처리 불요 — settings 쪽이 에러 코드로 안내).
  if (linkMode) {
    const spAt = cookieStore.get(SP_AT_COOKIE)?.value;
    if (!spAt) {
      return NextResponse.redirect(`${origin}/settings?link_error=SESSION_EXPIRED`);
    }
    const linkRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/oauth/${provider}/link/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spAt}` },
      body: JSON.stringify({ provider, code, state }),
    }).catch(() => null);

    if (!linkRes?.ok) {
      const errBody = await linkRes?.json().catch(() => null) as { error?: { code?: string } } | null;
      const errCode = errBody?.error?.code ?? 'LINK_FAILED';
      return NextResponse.redirect(`${origin}/settings?link_error=${errCode}`);
    }
    return NextResponse.redirect(`${origin}/settings?linked=${provider}`);
  }

  // story #3204 — proxy.ts가 랜딩 시점에 심어둔 first-touch 귀속 쿠키를 그대로 BE로 relay
  // (register route.ts와 동일 계약). 신규 유저 생성 분기에서만 BE가 실제로 사용한다.
  const utmSource = cookieStore.get('sp_attr_src')?.value;
  const utmMedium = cookieStore.get('sp_attr_medium')?.value;
  const utmCampaign = cookieStore.get('sp_attr_campaign')?.value;
  const attrReferrer = cookieStore.get('sp_attr_ref')?.value;

  // FastAPI OAuth callback
  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider, code, state, tos_accepted: tosAccepted, invite_token: inviteToken,
      ...(utmSource ? { signup_utm_source: utmSource } : {}),
      ...(utmMedium ? { signup_utm_medium: utmMedium } : {}),
      ...(utmCampaign ? { signup_utm_campaign: utmCampaign } : {}),
      ...(attrReferrer ? { signup_referrer: attrReferrer } : {}),
    }),
  }).catch(() => null);

  if (!fastapiRes?.ok) {
    const errBody = await fastapiRes?.json().catch(() => null) as { error?: { code?: string } } | null;
    const errCode = errBody?.error?.code ?? 'oauth_failed';
    return NextResponse.redirect(`${origin}/login?error=${errCode}`);
  }

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string; is_new_user?: boolean } };
  const { access_token, refresh_token, is_new_user: isNewUser } = json.data ?? {};

  if (!access_token || !refresh_token) {
    return NextResponse.redirect(`${origin}/login?error=oauth_no_token`);
  }

  // e-mobile-oauth-native-handoff-contract §5/§7.4/§10.1 — native OAuth-start였다면 웹 세션
  // 쿠키를 이 응답(Custom Tabs 컨텍스트)에 세팅하지 않는다(웹뷰와 쿠키 jar가 분리 — §0 문제
  // 그 자체). 대신 단회 부트스트랩 code를 발급해 App Link로 앱에 돌려준다. 격리 rail이므로
  // 기존 /auth/native(attested per-installation)는 여기서 절대 호출하지 않는다.
  if (nativeChallenge) {
    const userId = decodeJwtSub(access_token);
    if (!userId) {
      return NextResponse.redirect(`${origin}/login?error=oauth_native_issue_failed`);
    }
    const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
    // story #3121 AC1 — return_uri는 고정 매핑으로 계산(클라 입력 아님). APP_LINK_ORIGIN()은
    // 기존 App Link 리다이렉트 목적지 계산과 동일 출처(아래 returnUrl 참조) — 새 소스 안 만든다.
    const issueRes = await fetch(`${FASTAPI_URL()}/api/v2/internal/auth/oauth-handoff/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}),
      },
      body: JSON.stringify({
        user_id: userId,
        code_challenge: nativeChallenge,
        callback_mode: nativeCallbackMode,
        return_uri: expectedReturnUri(nativeCallbackMode, APP_LINK_ORIGIN()),
      }),
    }).catch(() => null);

    if (!issueRes || !issueRes.ok) {
      return NextResponse.redirect(`${origin}/login?error=oauth_native_issue_failed`);
    }
    const issueJson = (await issueRes.json().catch(() => null)) as { code?: unknown } | null;
    if (!issueJson || typeof issueJson.code !== 'string' || issueJson.code.length === 0) {
      return NextResponse.redirect(`${origin}/login?error=oauth_native_issue_failed`);
    }

    const returnUrl = new URL('/native/oauth-return', APP_LINK_ORIGIN());
    returnUrl.searchParams.set('code', issueJson.code);
    const nativeRes = NextResponse.redirect(returnUrl.toString());
    nativeRes.headers.set('Cache-Control', 'no-store');
    nativeRes.headers.set('Referrer-Policy', 'no-referrer');
    return nativeRes;
  }

  // AC3: 세션 만료로 OAuth 재로그인한 경우 작업 경로 복귀(safeNextPath 가드)·없으면 홈(chat).
  // story #3179(S3c) 후속(추가 실측 발견) — /dashboard 폐합, 홈=chat 재조준.
  const destinationUrl = new URL(
    inviteToken ? `${origin}/chats` : `${origin}${safeNextPath(nextCookie)}`,
  );
  // story #3204 — register/page.tsx(email 경로)와 동일 파라미터로 발화 지점을 하나로
  // 모은다(google-analytics.tsx route-change effect가 소비). is_new_user=false(로그인)면
  // 안 붙인다 — 재로그인마다 가입 이벤트가 중복 잡히면 안 됨.
  if (isNewUser) destinationUrl.searchParams.set('signup', '1');
  const destination = destinationUrl.toString();
  const res = NextResponse.redirect(destination);
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
  // 카디르 QA(PR#3612) — register route.ts와 동일 이유. is_new_user일 때만(신규 계정이
  // 실제로 이 귀속을 소비했을 때만) 지운다 — 기존 유저 로그인은 애초에 이 값을 안 썼으니
  // 지울 이유가 없다(다음 진짜 첫 방문 신호를 위해 남겨 둔다는 의미는 아니고, 그냥 소비
  // 안 한 값을 건드릴 이유가 없다는 뜻 — 어느 쪽이든 이후 실제 가입 시점에 갱신/소비됨).
  if (isNewUser) {
    for (const name of SIGNUP_ATTRIBUTION_COOKIE_NAMES) {
      res.cookies.set(name, '', { ...cookieBase(), maxAge: 0 });
    }
  }
  return res;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { provider } = await params;
  const { searchParams } = new URL(request.url);
  return handleCallback(request, provider, searchParams.get('code'), searchParams.get('state'));
}

// story #3118 — Apple의 form_post 콜백. 다른 provider는 이 메서드로 오지 않는다(Apple만
// response_mode=form_post를 요청) — handleCallback() 안의 provider 화이트리스트가 그
// 계약을 여전히 지킨다(누가 여기로 잘못 POST해도 provider가 없으면 즉시 invalid_provider).
export async function POST(request: Request, { params }: RouteParams) {
  const { provider } = await params;
  const form = await request.formData().catch(() => null);
  const code = typeof form?.get('code') === 'string' ? (form.get('code') as string) : null;
  const state = typeof form?.get('state') === 'string' ? (form.get('state') as string) : null;
  return handleCallback(request, provider, code, state);
}
