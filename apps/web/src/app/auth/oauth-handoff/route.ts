/**
 * e-mobile-oauth-native-handoff-contract (LOCKED) §5/§6 — OAuth 네이티브 핸드오프 consume 착지.
 *
 * ⚠️격리 rail(오르테가 확定, 2026-07-16): 이 라우트는 기존 `/auth/native`(#2218, per-installation
 * attested 부트스트랩)와 **물리적으로 분리된 별도 핸들러**다. 산티아고 §10.1이 명시적으로 금지한
 * 것이 바로 "필드유무로 attested 라우트에 OAuth 분기를 얹는" confused-deputy/downgrade 패턴 —
 * 그래서 세션-mint 내부기계(create_tokens/_store_refresh_token 등 BE 헬퍼)만 재사용하고, 라우트
 * 자체·BE 엔드포인트(`/api/v2/internal/auth/oauth-handoff/consume`)·DB 테이블(`oauth_handoff_codes`)
 * 은 attested 부트스트랩과 완전히 별개다. `/auth/native`는 이 스토리 범위에서 무접촉.
 *
 * mint 대상은 Firebase `__Host-sp_fs`가 아니라 **레거시 `sp_at`/`sp_rt`**다 — 실측 그라운딩 결과
 * 웹 Google OAuth 로그인(story #2155 이후 GitHub 로그인 제거 — App/봇 연동은 별개)이 Firebase를
 * 전혀 쓰지 않고(`getServerSession()`의 비-Firebase
 * 폴백 경로가 실 인증 경로) 레거시 JWT 쌍을 발급하는 구조였기 때문(오르테가 확定, Firebase 이관은
 * 스코프 밖). 쿠키 세팅은 `/api/auth/callback/[provider]/route.ts`와 동일 규약(`cookieBase()`).
 *
 * WebView 네비게이션 계약(#2218과 동형): top-level POST(Android postUrl/자동제출 form)여야
 * Set-Cookie가 웹뷰 쿠키저장소에 축적된다 — fetch()는 이 계약을 만족 못 한다.
 *
 * §10.9 확定(산티아고, 2026-07-16): `verifyCsrfOrigin()`은 리터럴 `Origin: null` 헤더를
 * 403으로 거부한다(고정 결정, 완화 금지) — 실기기 웹뷰 트래픽(#2218 검증분)은 이 헤더를 안
 * 보내는 것으로 확認됐고, 향후 특정 OEM에서 재현되면 기본 허용 완화가 아니라 별도
 * compatibility finding + 제한된 대체 검증 설계로 다뤄야 한다.
 */
import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase, SP_AT_MAX_AGE_SECONDS } from '@/lib/auth/cookies';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';
import { resolveAppUrl } from '@/services/app-url';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function logHandoffFailure(reason: string): void {
  // §10.4: code/verifier/원문 절대 로그 금지 — reason enum만.
  console.warn(`auth.oauth-handoff.consume 실패 reason=${reason}`);
}

function handoffFailedResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'OAUTH_HANDOFF_FAILED', message: 'OAuth handoff failed' } },
    { status: 401, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

interface HandoffBody {
  code?: unknown;
  code_verifier?: unknown;
}

async function parseBody(request: Request): Promise<HandoffBody | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await request.json()) as HandoffBody;
    }
    const raw = await request.text();
    const params = new URLSearchParams(raw);
    return { code: params.get('code') ?? undefined, code_verifier: params.get('code_verifier') ?? undefined };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (process.env['FIREBASE_OAUTH_HANDOFF_ENABLED'] !== 'true') {
    logHandoffFailure('not_enabled');
    return NextResponse.json(
      { error: { code: 'NOT_ENABLED', message: 'OAuth handoff is not enabled' } },
      { status: 501 },
    );
  }

  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) {
    logHandoffFailure('csrf_rejected');
    return csrfError;
  }

  const body = await parseBody(request);
  if (!body || typeof body.code !== 'string' || body.code.length === 0
    || typeof body.code_verifier !== 'string' || body.code_verifier.length === 0) {
    logHandoffFailure('missing_fields');
    return handoffFailedResponse();
  }

  const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
  const consumeRes = await fetch(`${FASTAPI_URL()}/api/v2/internal/auth/oauth-handoff/consume`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}),
    },
    body: JSON.stringify({ code: body.code, code_verifier: body.code_verifier }),
  }).catch(() => null);

  if (!consumeRes || !consumeRes.ok) {
    logHandoffFailure('consume_failed');
    return handoffFailedResponse();
  }

  const consumeJson = (await consumeRes.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
  if (!consumeJson || typeof consumeJson.access_token !== 'string' || consumeJson.access_token.length === 0
    || typeof consumeJson.refresh_token !== 'string' || consumeJson.refresh_token.length === 0) {
    logHandoffFailure('malformed_consume_response');
    return handoffFailedResponse();
  }

  // §10.9: 리다이렉트 목적지는 상대경로 고정(/glance) — client-supplied redirect_path 없음
  // (attested /auth/native와 달리 이 흐름엔 그런 파라미터 자체가 계약에 없다).
  // ⚠️base는 request.url이 아니라 resolveAppUrl()이어야 한다 — Cloud Run에서 request.url의
  // origin이 내부 bind 주소(0.0.0.0:PORT)로 해석돼 웹뷰가 unreachable host로 리다이렉트되는
  // 사고를 오르테가 실측으로 잡았다(선생님 3번째 에러 근본원인). /api/auth/callback/[provider]
  // 의 origin(=resolveAppUrl(null)) 패턴과 동일하게 맞춘다.
  const res = NextResponse.redirect(`${resolveAppUrl(null)}/glance`, 303);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.cookies.set(SP_AT_COOKIE, consumeJson.access_token, { ...cookieBase(), maxAge: SP_AT_MAX_AGE_SECONDS });
  res.cookies.set(SP_RT_COOKIE, consumeJson.refresh_token, { ...cookieBase(), maxAge: 30 * 24 * 60 * 60 });

  console.info('auth.oauth-handoff.consume success');
  return res;
}
