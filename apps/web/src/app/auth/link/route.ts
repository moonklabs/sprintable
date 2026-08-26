import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';
import { oauthCookieOptions } from '@/lib/auth/oauth-cookies';
import { SP_AT_COOKIE } from '@/lib/db/server';

const FASTAPI_BASE = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// story #3122(계정·후속 — 수동 계정 연결) — auth/login/route.ts와 형태는 닮았지만 의미가
// 다르다: 저건 "아직 로그인 안 된 사람을 로그인/가입시키는" rail이고 이건 "이미 로그인된
// 이 계정에 다른 provider를 붙이는" rail이다. 그래서 별도 route로 뺐다(tos_accepted·
// invite_token 같은 로그인 전용 파라미터가 여기엔 의미가 없고, sp_at 쿠키가 반드시 있어야
// 하는 게 진입 조건 자체다). BE authorize 호출에 Authorization 헤더로 그 sp_at을 실어야
// state에 link_user_id(누구에게 붙일지)가 실린다(auth.py oauth_link_authorize).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get('provider');
  const origin = resolveAppUrl(null);

  if (!provider || !['google', 'apple'].includes(provider)) {
    return NextResponse.redirect(`${origin}/settings?link_error=INVALID_PROVIDER`);
  }

  const cookieStore = await cookies();
  const spAt = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!spAt) {
    // 링크는 로그인된 계정 전용 — 세션이 없으면 로그인부터.
    return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent('/settings')}`);
  }

  const res = await fetch(`${FASTAPI_BASE}/api/v2/auth/oauth/${provider}/link/authorize`, {
    headers: { Authorization: `Bearer ${spAt}` },
  }).catch(() => null);
  if (!res?.ok) {
    return NextResponse.redirect(`${origin}/settings?link_error=LINK_INIT_FAILED`);
  }

  const json = await res.json() as { data?: { url?: string; state?: string } };
  const url = json.data?.url;
  const state = json.data?.state;
  if (!url || !state) {
    return NextResponse.redirect(`${origin}/settings?link_error=LINK_INIT_FAILED`);
  }

  const cookieOpts = oauthCookieOptions(provider);
  cookieStore.set(`oauth_state_${provider}`, state, cookieOpts);
  // 콜백(api/auth/callback/[provider]/route.ts)이 이 쿠키의 존재로 "로그인이 아니라 연결
  // 콜백"임을 판별한다 — provider 쪽에서 보내는 code/state 자체엔 이 구분이 없다(authorize
  // 요청 파라미터가 로그인과 동일하게 생겼다, 의도된 설계 — 콘솔 콜백 도메인 재등록 불요).
  cookieStore.set(`oauth_link_${provider}`, 'true', cookieOpts);

  return NextResponse.redirect(url);
}
