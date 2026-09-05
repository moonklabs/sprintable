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

  // story #3407 — Meta가 사용자 거부 시 code 없이 `?error=access_denied&state=...`로
  // 돌려준다. 아래 code/state/orgId 체크보다 먼저 봐야 한다 — 안 그러면 "파라미터
  // 누락"(OAUTH_MISSING_PARAMS, 일반 실패 문구)으로 오진단돼, 사용자가 명시적으로 거부한
  // 것이 마치 시스템 오류처럼 보인다(페드루 PO 라이브 실측). error_description/
  // error_reason은 서버 로그에만 — URL 쿼리에는 Meta 원문을 절대 안 싣는다.
  //
  // 페드루 리뷰 후속 — Meta는 같은 `error` 파라미터로 access_denied(사용자 거부) 외에
  // server_error·temporarily_unavailable류(제공자 쪽 오류)도 보낸다. 전부 "거부"로
  // 뭉치면 그 자체가 또 다른 오진단이라, access_denied/user_denied만 OAUTH_PROVIDER_DENIED,
  // 나머지는 OAUTH_PROVIDER_ERROR로 가른다.
  const providerError = searchParams.get('error');
  if (providerError) {
    const errorReason = searchParams.get('error_reason');
    console.error('[oauth-channel/callback] provider error', {
      channel,
      error: providerError,
      error_description: searchParams.get('error_description'),
      error_reason: errorReason,
    });
    const isUserDenied = providerError === 'access_denied' || errorReason === 'user_denied';
    const connectError = isUserDenied ? 'OAUTH_PROVIDER_DENIED' : 'OAUTH_PROVIDER_ERROR';
    return NextResponse.redirect(`${origin}/organization/channels?connect_error=${connectError}`);
  }

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

  // story #3549(3547 BE·디디 계약, 유나 §13-8②, PO 確定 2026-09-06) — Facebook Page가
  // 2개 이상이면 BE가 연결을 만들지 않고 `{kind:"pending_selection", pending_id,
  // candidates:[{page_id,name}], expires_at}`을 돌려준다(기존 `ChannelConnectionResponse`
  // 에 `kind` additive — threads·instagram은 이 필드가 아예 없어 항상 이 분기를
  // 건너뛴다). 브라우저 리다이렉트는 POST 바디를 못 옮기므로 다음 요청(GET
  // /organization/channels)이 스스로 다시 그릴 수 있게 후보 목록·만료 시각을 쿼리에
  // 싣는다 — 크기는 항상 작다(한 Meta 계정이 관리하는 Page 이름·ID뿐, §13-8⑦
  // "미리보기 없음" 규율과 같은 이유로 원래도 가벼운 데이터).
  const successBody = await res.json().catch(() => null) as {
    kind?: string; pending_id?: string; candidates?: { page_id: string; name: string }[]; expires_at?: string;
  } | null;
  if (successBody?.kind === 'pending_selection' && successBody.pending_id) {
    const params = new URLSearchParams({
      select_pending: channel,
      pending_id: successBody.pending_id,
      candidates: JSON.stringify(successBody.candidates ?? []),
    });
    if (successBody.expires_at) params.set('expires_at', successBody.expires_at);
    return NextResponse.redirect(`${origin}/organization/channels?${params.toString()}`);
  }

  return NextResponse.redirect(`${origin}/organization/channels?connected=${channel}`);
}
