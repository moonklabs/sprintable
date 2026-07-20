import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';

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
  const origin = resolveAppUrl(null);

  if (!provider || !['google', 'github'].includes(provider)) {
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
  cookieStore.set(`oauth_state_${provider}`, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 300,
    path: '/',
  });
  if (tosAccepted) {
    cookieStore.set(`oauth_tos_${provider}`, 'true', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300,
      path: '/',
    });
  }
  if (inviteToken) {
    cookieStore.set(`oauth_invite_token_${provider}`, inviteToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300,
      path: '/',
    });
  }
  if (next) {
    cookieStore.set(`oauth_next_${provider}`, next, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300,
      path: '/',
    });
  }
  // §10.3: code_challenge는 base64url(패딩없음) 43자 이상만 수용 — 형식이 다르면 native
  // 핸드오프 자체를 시작하지 않는다(방어적, 최종 검증은 BE issue가 authoritative).
  if (native && codeChallenge && /^[A-Za-z0-9_-]{43,}$/.test(codeChallenge)) {
    cookieStore.set(`oauth_native_challenge_${provider}`, codeChallenge, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 300,
      path: '/',
    });
  }

  return NextResponse.redirect(url);
}
