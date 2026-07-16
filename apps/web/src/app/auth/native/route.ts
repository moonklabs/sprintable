/**
 * story f755b1a9(E-AUTH-REBUILD M2 활성화 게이트 6ae1ecac 하위·doc §9.1): `POST /auth/native` —
 * 네이티브 WebView가 단회 부트스트랩 코드를 들고 오는 착지 라우트. code+device_binding_hash를
 * **exact-origin POST body로만** 받는다(query 사용 금지 — PO 확定, doc §9.1의 `?code=`
 * best-known을 대체). 내부 atomic-consume API(`/api/v2/internal/auth/native-bootstrap/consume`,
 * S4와 동일 공유시크릿 패턴)를 호출해 `__Host-sp_fs` 세션쿠키를 받아 그대로 심고, 원래 딥링크
 * 경로로 303 리다이렉트한다.
 *
 * ⚠️logged-out login-CSRF(story 6ae1ecac AC#2): BE `existing_session_user_id` 비교는 이미
 * 머지돼있다(#2202 finding3) — 이 라우트의 책임은 그 값을 **클라이언트가 body/query로 보낸
 * 값을 절대 신뢰하지 않고, 서버가 직접 검증한 `__Host-sp_fs` 세션에서만 도출**하는 것이다.
 * 완전한 "로그아웃 상태 피해자에게 공격자 code 소비" 방어(per-installation attestation)는 이
 * 라우트만으론 봉쇄 불가 — story 6ae1ecac condition①(별도 스코프)로 명시 분리한다.
 *
 * WebView 네비게이션 계약(민군 wire 합의, 2026-07-16): top-level POST 네비게이션(Android
 * `postUrl`/자동제출 form)이어야 303+Set-Cookie가 WebView 자체 쿠키저장소에 축적된다 — 순수
 * fetch()는 페이지 네비게이션이 아니라 이 계약을 만족하지 못한다. Content-Type은 JSON 또는
 * urlencoded 둘 다 파싱(민군 postUrl 페이로드 형식 자유도).
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { setFirebaseSessionCookie, SP_FS_COOKIE } from '@/lib/auth/firebase-session';
import { safeNextPath } from '@/lib/auth/session-redirect';
import { cookieBase } from '@/lib/auth/cookies';
import { SP_AT_COOKIE, SP_RT_COOKIE, resolveFirebaseServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function logBootstrapFailure(reason: string): void {
  // doc §9.1: code/쿼리/원문 절대 로그 금지 — reason enum만.
  console.warn(`auth.native.consume 실패 reason=${reason}`);
}

function bootstrapFailedResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'NATIVE_BOOTSTRAP_FAILED', message: 'Native bootstrap failed' } },
    { status: 401, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
  );
}

interface NativeBootstrapBody {
  code?: unknown;
  device_binding_hash?: unknown;
  redirect_path?: unknown;
}

async function parseBody(request: Request): Promise<NativeBootstrapBody | null> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await request.json()) as NativeBootstrapBody;
    }
    // application/x-www-form-urlencoded(자동제출 form/native postUrl 페이로드) 지원.
    const raw = await request.text();
    const params = new URLSearchParams(raw);
    return {
      code: params.get('code') ?? undefined,
      device_binding_hash: params.get('device_binding_hash') ?? undefined,
      redirect_path: params.get('redirect_path') ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (process.env['FIREBASE_AUTH_MOBILE_ISSUE'] !== 'true') {
    logBootstrapFailure('not_enabled');
    return NextResponse.json(
      { error: { code: 'NOT_ENABLED', message: 'Native bootstrap is not enabled' } },
      { status: 501 },
    );
  }

  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) {
    logBootstrapFailure('csrf_rejected');
    return csrfError;
  }

  const body = await parseBody(request);
  if (!body || typeof body.code !== 'string' || body.code.length === 0) {
    logBootstrapFailure('missing_code');
    return bootstrapFailedResponse();
  }
  const code = body.code;
  const deviceBindingHash = typeof body.device_binding_hash === 'string' ? body.device_binding_hash : undefined;
  const redirectPathInput = typeof body.redirect_path === 'string' ? body.redirect_path : undefined;

  // logged-out login-CSRF(story 6ae1ecac AC#2): existing_session_user_id는 client body/query
  // 값을 절대 쓰지 않는다 — 여기서 서버가 직접 __Host-sp_fs를 검증해 도출한 값만 사용.
  const cookieStore = await cookies();
  const existingFirebaseSessionCookie = cookieStore.get(SP_FS_COOKIE)?.value;
  let existingSessionUserId: string | undefined;
  if (existingFirebaseSessionCookie) {
    const existingSession = await resolveFirebaseServerSession(existingFirebaseSessionCookie);
    if (existingSession) existingSessionUserId = existingSession.user_id;
  }

  const internalSecret = process.env['FIREBASE_BFF_INTERNAL_SECRET'];
  const consumeRes = await fetch(`${FASTAPI_URL()}/api/v2/internal/auth/native-bootstrap/consume`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(internalSecret ? { Authorization: `Bearer ${internalSecret}` } : {}),
    },
    body: JSON.stringify({
      code,
      device_binding_hash: deviceBindingHash,
      existing_session_user_id: existingSessionUserId,
    }),
  }).catch(() => null);

  if (!consumeRes || !consumeRes.ok) {
    logBootstrapFailure('consume_failed');
    return bootstrapFailedResponse();
  }

  const consumeJson = (await consumeRes.json().catch(() => null)) as { session_cookie?: unknown } | null;
  if (!consumeJson || typeof consumeJson.session_cookie !== 'string' || consumeJson.session_cookie.length === 0) {
    logBootstrapFailure('malformed_consume_response');
    return bootstrapFailedResponse();
  }

  // doc §9.1 6단계: 303 + 원래 딥링크 경로(허용목록 검증) + no-store + Referrer-Policy: no-referrer
  // (code가 이 응답 이전 요청의 body에만 있었으므로 여기선 이미 무관 — 그래도 방어적으로 설정).
  const target = safeNextPath(redirectPathInput);
  const res = NextResponse.redirect(new URL(target, request.url), 303);
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  setFirebaseSessionCookie(res, consumeJson.session_cookie);

  // /api/auth/firebase/session/route.ts와 동형 패턴: 세션 확립 성공 후 레거시 쿠키 정리.
  const clearBase = { ...cookieBase(), maxAge: 0 };
  res.cookies.set(SP_AT_COOKIE, '', clearBase);
  res.cookies.set(SP_RT_COOKIE, '', clearBase);

  console.info('auth.native.consume success');
  return res;
}
