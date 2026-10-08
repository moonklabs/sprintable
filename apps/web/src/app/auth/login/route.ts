import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';
import { oauthCookieOptions } from '@/lib/auth/oauth-cookies';
import { isOAuthCallbackMode } from '@/lib/auth/oauth-callback-mode';
import { nativeReturnApp } from '@/lib/auth/native-return-app';

const FASTAPI_BASE = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider');
  const tosAccepted = searchParams.get('tos_accepted') === 'true';
  const inviteToken = searchParams.get('invite_token');
  const next = searchParams.get('next'); // AC3: 세션 만료 복귀 경로 — 콜백서 safeNextPath 로 검증 후 복귀
  // e-mobile-oauth-native-handoff-contract §7.4: 네이티브 셸이 Custom Tabs로 이 URL을 열 때
  // native=1 + PKCE code_challenge(S256)를 부착 — 콜백에서 이 값을 세션쿠키 대신 oauth-handoff
  // issue 호출에 씀(격리 rail, /auth/native 무접촉).
  const native = searchParams.get('native') === '1';
  const codeChallenge = searchParams.get('code_challenge');
  // story #3121 AC1 — 모바일이 OAuth 시작 전 정적으로 결정한 호환 모드(계약 §2). 값 자체가
  // 아니라 셸렉터일 뿐이라 여기선 형식만 검증(https|custom_scheme) — 실제 return_uri 문자열은
  // 콜백(callback/[provider]/route.ts)에서 lib/auth/oauth-callback-mode 고정 매핑으로 계산한다.
  const callbackModeParam = searchParams.get('callback_mode');
  const origin = resolveAppUrl(null);

  // story #3118(Sign in with Apple) — apple 추가. 노출 여부(iOS/macOS 셸 한정)는 로그인
  // 버튼 렌더 게이트에서 이미 걸린다(login/page.tsx) — 여기는 provider 자체의 유효성만 본다.
  if (!provider || !['google', 'apple'].includes(provider)) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const res = await fetch(`${FASTAPI_BASE}/api/v2/auth/oauth/${provider}/authorize`).catch(() => null);
  if (!res?.ok) {
    return NextResponse.redirect(`${origin}/login?error=oauth_init_failed`);
  }

  const json = await res.json() as { data?: { url?: string; state?: string } };
  const url = json.data?.url;
  const state = json.data?.state;

  if (!url || !state) {
    return NextResponse.redirect(`${origin}/login?error=oauth_init_failed`);
  }

  const cookieStore = await cookies();
  const cookieOpts = oauthCookieOptions(provider);
  // story #4628: each start says all of its own values — one it does not carry is deleted, not left from an earlier start that
  // never came back (5 minutes): a web sign-in after an abandoned native start went down the native branch (handoff, no
  // session) and carried the old `next` / invite token. The callback reads and deletes them all, so only abandoned starts left any.
  const setOrDrop = (name: string, value: string | null) => {
    if (value) cookieStore.set(`${name}_${provider}`, value, cookieOpts);
    else cookieStore.delete(`${name}_${provider}`);
  };
  cookieStore.set(`oauth_state_${provider}`, state, cookieOpts);
  setOrDrop('oauth_tos', tosAccepted ? 'true' : null);
  setOrDrop('oauth_invite_token', inviteToken);
  setOrDrop('oauth_next', next);
  // §10.3: code_challenge는 base64url(패딩없음) 43자 이상만 수용 — 형식이 다르면 native
  // 핸드오프 자체를 시작하지 않는다(방어적, 최종 검증은 BE issue가 authoritative).
  const nativeStart = native && codeChallenge && /^[A-Za-z0-9_-]{43,}$/.test(codeChallenge);
  setOrDrop('oauth_native_challenge', nativeStart ? codeChallenge : null);
  // story #3121 AC1 — 형식이 다르면(구버전 클라 미전송 포함) 조용히 기본값(https)으로 유도
  // 되게 쿠키 자체를 세팅 안 한다(콜백에서 쿠키 부재 = https). 잘못된 값은 저장하지 않는다
  // (오배선을 그대로 실어 나르지 않는다). #4628: 세팅 안 할 때는 옛 값도 지운다.
  setOrDrop('oauth_native_callback_mode', nativeStart && isOAuthCallbackMode(callbackModeParam) ? callbackModeParam : null);
  // story #4626 — which desktop app to hand back to: only a value in the closed table is kept (anything else = the default,
  // no cookie at all — nothing from the URL is carried as it came); a native start only. #4628: any start without one drops
  // a cookie left by an earlier start that never came back (Kadir 08:18Z: else the next sign-in from the default app went to
  // the check app)
  setOrDrop('oauth_native_return_app', nativeStart ? nativeReturnApp(searchParams.get('return_app')) : null);

  return NextResponse.redirect(url);
}
