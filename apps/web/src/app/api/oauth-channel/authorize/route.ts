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
  // story #3650(PO Test Org 실측 2026-09-07) — 「다시 연결」 대상 행. 없으면(신규
  // 연결) 기존 동작 그대로 — BE authorize가 body 없이도 받는다.
  const connectionId = searchParams.get('connection_id');
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
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${spAt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_connection_id: connectionId ?? undefined }),
    },
  ).catch(() => null);

  if (!res?.ok) {
    const errBody = await res?.json().catch(() => null) as { error?: { code?: string; error_id?: string } } | null;
    const errCode = errBody?.error?.code ?? 'CHANNEL_AUTHORIZE_FAILED';
    // story #3672(2026-09-07, 3663 실사고) — BE unhandled_exception_handler가 실어 준
    // error_id가 있으면 그대로 넘긴다(있을 때만·없으면 기존 동작 그대로, AC4).
    const errorId = errBody?.error?.error_id;
    const suffix = errorId ? `&error_id=${encodeURIComponent(errorId)}` : '';
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=${errCode}${suffix}`);
  }

  // story #3613(BE 그라운딩·페드루 PO 確定 2026-09-07) — BE `authorize_channel_
  // connection`(channel_connections.py:403)은 `response_model=AuthorizeResponse`로
  // 성공 응답을 맨몸(`{url,state}`)으로 낸다 — backend/app에 성공 응답 전역 봉투가
  // 없어(에러만 http_exception_handler가 `{error:{code,message}}`로 감싼다) 이
  // 원시 fetch 라우트가 성공 시 `json.data?.url`을 읽으면 항상 undefined였다(이
  // 파일 생성 시점부터 한 번도 성립한 적 없던 형 — #3907 squash 유일 커밋).
  // «형은 한 곳에서만 정의» 원칙: 이 라우트는 BE를 직접 부르므로 BE의 실제 성공
  // 형(맨몸)을 그대로 읽는다(sibling proxy 라우트는 apiSuccess로 다시 감싸므로
  // 그쪽만 `.data.url`이 맞다 — 두 라우트가 각자의 실제 소스 형을 따른다).
  const json = await res.json() as { url?: string };
  const url = json.url;
  if (!url) {
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=CHANNEL_AUTHORIZE_FAILED`);
  }

  // 콜백(app/api/oauth-channel/callback/[channel]/route.ts)이 이 쿠키로 org_id를 되찾는다 —
  // BE의 state 자체는 opaque(디코드 안 함), 이 쿠키가 유일하게 FE가 들고 가는 컨텍스트.
  cookieStore.set(`oauth_channel_org_${channel}`, orgId, oauthCookieOptions(channel));
  return NextResponse.redirect(url);
}
