import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { resolveAppUrl } from '@/services/app-url';
import { SP_AT_COOKIE } from '@/lib/db/server';

const FASTAPI_BASE = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// story #3376 — PR#3736의 redirect_uri가 정확히 이 경로를 가리킨다(그라운딩 §10 실 diff
// 확認: `f"{settings.app_url}/api/oauth-channel/callback/{channel}"`). Meta가 여기로
// code·state를 GET 쿼리로 돌려주면, org_id는 authorize 라우트가 남긴 단명 쿠키에서 되찾아
// BE 콜백(POST .../channel-connections/{channel}/callback)에 그대로 릴레이한다 — state
// 자체의 유효성(위조·만료·org 불일치)은 전부 BE가 검증한다(CHANNEL_OAUTH_STATE_INVALID).
type RouteParams = { params: Promise<{ channel: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { channel } = await params;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const origin = resolveAppUrl(null);

  const cookieStore = await cookies();
  const orgId = cookieStore.get(`oauth_channel_org_${channel}`)?.value;
  cookieStore.delete(`oauth_channel_org_${channel}`);

  if (!code || !state || !orgId) {
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=OAUTH_MISSING_PARAMS`);
  }

  const spAt = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!spAt) {
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=SESSION_EXPIRED`);
  }

  const res = await fetch(
    `${FASTAPI_BASE}/api/v2/organizations/${orgId}/channel-connections/${channel}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spAt}` },
      body: JSON.stringify({ code, state }),
    },
  ).catch(() => null);

  if (!res?.ok) {
    const errBody = await res?.json().catch(() => null) as { error?: { code?: string } } | null;
    const errCode = errBody?.error?.code ?? 'CHANNEL_CALLBACK_FAILED';
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=${errCode}`);
  }

  return NextResponse.redirect(`${origin}/organization/channels?connected=${channel}`);
}
