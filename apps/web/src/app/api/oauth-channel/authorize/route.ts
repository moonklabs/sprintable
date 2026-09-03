import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';
import { oauthCookieOptions } from '@/lib/auth/oauth-cookies';
import { SP_AT_COOKIE } from '@/lib/db/server';

const FASTAPI_BASE = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// story #3376 — app/auth/link/route.ts와 동형 레일(그라운딩 §3·§10, 새 패턴 발명 0).
// 다른 점 하나: 로그인 rail은 provider 하나뿐이라 콜백이 "누구 계정에 붙일지"를 세션의
// sp_at만으로 알 수 있지만, 이건 org-scoped 리소스(channel_connections)라 콜백이 org_id도
// 알아야 한다 — BE authorize 응답 자체엔 org_id가 없어(그라운딩 §10 확認, AuthorizeResponse
// ={url,state}뿐) state를 FE가 디코드하지 않고 그대로 단명 쿠키에 얹어 왕복시킨다.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get('org');
  const channel = searchParams.get('channel');
  const origin = resolveAppUrl(null);

  if (!orgId || !channel) {
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=INVALID_REQUEST`);
  }

  const cookieStore = await cookies();
  const spAt = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!spAt) {
    return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent('/organization/channels')}`);
  }

  const res = await fetch(
    `${FASTAPI_BASE}/api/v2/organizations/${orgId}/channel-connections/${channel}/authorize`,
    { method: 'POST', headers: { Authorization: `Bearer ${spAt}` } },
  ).catch(() => null);

  if (!res?.ok) {
    const errBody = await res?.json().catch(() => null) as { error?: { code?: string } } | null;
    const errCode = errBody?.error?.code ?? 'CHANNEL_AUTHORIZE_FAILED';
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=${errCode}`);
  }

  const json = await res.json() as { data?: { url?: string } };
  const url = json.data?.url;
  if (!url) {
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=CHANNEL_AUTHORIZE_FAILED`);
  }

  // 콜백(app/api/oauth-channel/callback/[channel]/route.ts)이 이 쿠키로 org_id를 되찾는다 —
  // BE의 state 자체는 opaque(디코드 안 함), 이 쿠키가 유일하게 FE가 들고 가는 컨텍스트.
  cookieStore.set(`oauth_channel_org_${channel}`, orgId, oauthCookieOptions(channel));
  return NextResponse.redirect(url);
}
