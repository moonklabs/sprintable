/**
 * story 132e7204(E-AUTH-REBUILD M2 Phase1-S4·doc §4.4): POST /api/auth/firebase/session 실구현.
 *
 * BFF는 Firebase Admin 왕복을 직접 하지 않는다 — 이미 CSRF 검증된 요청의 id_token을 FastAPI
 * 내부 엔드포인트(`/api/v2/internal/auth/firebase-session`, 공유시크릿 인증)로 그대로 전달해
 * ID token 정확검증+identity 매핑+auth_time 최근성+실 Google `createSessionCookie` 발급까지
 * 백엔드가 전담하고, 완성된 세션쿠키 값만 돌려받아 `setFirebaseSessionCookie()`(S3, __Host-
 * Domain-less 보장)로 그대로 심는다.
 *
 * ⛔실패 시 어떤 이유든(ID token 무효/미매핑/mint 실패) **동일하게 401 SESSION_EXCHANGE_FAILED**
 * 로 응답 — 실패 사유를 클라이언트에 구분해 노출하면 enumeration에 악용될 수 있다(doc §6.2
 * neutral anti-enumeration 원칙 재사용). 상세 사유는 서버 로그(logSessionFailure)에만 남긴다.
 */
import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { setFirebaseSessionCookie } from '@/lib/auth/firebase-session';
import { cookieBase } from '@/lib/auth/cookies';
import { SP_AT_COOKIE, SP_RT_COOKIE } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// doc §5 Phase1 항목5(issuer별 metrics+neutral failure reason).
function logSessionFailure(reason: string): void {
  console.warn(`auth.firebase.session 실패 reason=${reason}`);
}

function sessionExchangeFailedResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'SESSION_EXCHANGE_FAILED', message: 'Session exchange failed' } },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  if (process.env['FIREBASE_AUTH_ISSUE_SESSION'] !== 'true') {
    logSessionFailure('not_enabled');
    return NextResponse.json(
      { error: { code: 'NOT_ENABLED', message: 'Firebase session issuance is not enabled' } },
      { status: 501 },
    );
  }

  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) {
    logSessionFailure('csrf_rejected');
    return csrfError;
  }

  let idToken: string;
  try {
    const body = (await request.json()) as { id_token?: unknown };
    if (typeof body.id_token !== 'string' || body.id_token.length === 0) {
      logSessionFailure('missing_id_token');
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'id_token required' } },
        { status: 400 },
      );
    }
    idToken = body.id_token;
  } catch {
    logSessionFailure('invalid_body');
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
  const mintRes = await fetch(`${FASTAPI_URL()}/api/v2/internal/auth/firebase-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}),
    },
    body: JSON.stringify({ id_token: idToken }),
  }).catch(() => null);

  if (!mintRes || !mintRes.ok) {
    logSessionFailure('mint_failed');
    return sessionExchangeFailedResponse();
  }

  const mintJson = (await mintRes.json().catch(() => null)) as { session_cookie?: unknown } | null;
  if (!mintJson || typeof mintJson.session_cookie !== 'string' || mintJson.session_cookie.length === 0) {
    logSessionFailure('malformed_mint_response');
    return sessionExchangeFailedResponse();
  }

  // doc §4.4 7단계: 세션쿠키를 JSON 바디에 절대 포함하지 않는다 — Set-Cookie 헤더로만 전달.
  const res = NextResponse.json({ data: { ok: true } }, { headers: { 'Cache-Control': 'no-store' } });
  setFirebaseSessionCookie(res, mintJson.session_cookie);

  // doc §4.4 7단계: 세션 확립 성공 후 단일계정 코호트 legacy 쿠키 정리(logout route와 동형 패턴).
  const clearBase = { ...cookieBase(), maxAge: 0 };
  res.cookies.set(SP_AT_COOKIE, '', clearBase);
  res.cookies.set(SP_RT_COOKIE, '', clearBase);

  console.info('auth.firebase.session success');
  return res;
}
