import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { safeNextPath } from '@/lib/auth/session-redirect';
import { resolveAppUrl } from '@/services/app-url';

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
  cookieStore.delete(`oauth_state_${provider}`);
  cookieStore.delete(`oauth_tos_${provider}`);
  cookieStore.delete(`oauth_invite_token_${provider}`);
  cookieStore.delete(`oauth_next_${provider}`);
  cookieStore.delete(`oauth_native_challenge_${provider}`);

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

  // FastAPI OAuth callback
  const fastapiRes = await fetch(`${FASTAPI_URL()}/api/v2/auth/oauth/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, code, state, tos_accepted: tosAccepted, invite_token: inviteToken }),
  }).catch(() => null);

  if (!fastapiRes?.ok) {
    const errBody = await fastapiRes?.json().catch(() => null) as { error?: { code?: string } } | null;
    const errCode = errBody?.error?.code ?? 'oauth_failed';
    return NextResponse.redirect(`${origin}/login?error=${errCode}`);
  }

  const json = await fastapiRes.json() as { data?: { access_token: string; refresh_token: string } };
  const { access_token, refresh_token } = json.data ?? {};

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
    const issueRes = await fetch(`${FASTAPI_URL()}/api/v2/internal/auth/oauth-handoff/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}),
      },
      body: JSON.stringify({ user_id: userId, code_challenge: nativeChallenge }),
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

  // AC3: 세션 만료로 OAuth 재로그인한 경우 작업 경로 복귀(safeNextPath 가드)·없으면 기존 /inbox.
  const destination = inviteToken ? `${origin}/dashboard` : `${origin}${safeNextPath(nextCookie)}`;
  const res = NextResponse.redirect(destination);
  res.cookies.set(SP_AT_COOKIE, access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });
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
