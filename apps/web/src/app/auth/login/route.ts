import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';

const FASTAPI_BASE = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// story #3118(Sign in with Apple) — PO 전언(페드루, 민 그라운딩 축): scope에 name/email이
// 있는 Apple 콜백은 GET 리다이렉트가 아니라 cross-site POST(response_mode=form_post)로
// 온다. SameSite=Lax 쿠키는 cross-site *POST*엔 안 실린다(Lax는 top-level GET 네비게이션만
// 봐준다) — 이 5개 oauth_* 쿠키가 Lax로 남아있으면 Apple 콜백에서 state 검증이 "쿠키가 아예
// 안 옴"으로 매번 헛실패한다(잘 알려진 함정 클래스). Apple만 SameSite=None(+Secure 필수 —
// 브라우저가 None을 Secure 없이 거부)으로 쓴다. Google은 GET 리다이렉트라 Lax로 충분 —
// 그대로 둔다(불필요하게 None으로 넓히지 않는다, 최소 권한).
function oauthCookieOptions(provider: string) {
  if (provider === 'apple') {
    return { httpOnly: true, secure: true, sameSite: 'none' as const, maxAge: 300, path: '/' };
  }
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: 300, path: '/' };
}

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
  cookieStore.set(`oauth_state_${provider}`, state, cookieOpts);
  if (tosAccepted) {
    cookieStore.set(`oauth_tos_${provider}`, 'true', cookieOpts);
  }
  if (inviteToken) {
    cookieStore.set(`oauth_invite_token_${provider}`, inviteToken, cookieOpts);
  }
  if (next) {
    cookieStore.set(`oauth_next_${provider}`, next, cookieOpts);
  }
  // §10.3: code_challenge는 base64url(패딩없음) 43자 이상만 수용 — 형식이 다르면 native
  // 핸드오프 자체를 시작하지 않는다(방어적, 최종 검증은 BE issue가 authoritative).
  if (native && codeChallenge && /^[A-Za-z0-9_-]{43,}$/.test(codeChallenge)) {
    cookieStore.set(`oauth_native_challenge_${provider}`, codeChallenge, cookieOpts);
  }

  return NextResponse.redirect(url);
}
