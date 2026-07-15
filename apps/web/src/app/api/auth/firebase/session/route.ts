/**
 * story 386a8b56(E-AUTH-REBUILD M2 Phase1-S3·doc §4.4): POST /api/auth/firebase/session 스캐폴드.
 * FIREBASE_AUTH_ISSUE_SESSION=false(기본) 동안은 501 — Firebase Admin SDK 초기화/실 ID token
 * 검증/identity resolve 로직은 이 플래그가 켜지고 Firebase 프로젝트가 준비된 후 Phase 2+에서
 * 채운다(doc §5 Phase 1 스코프=검증기+스키마까지, 실 발급은 Phase 2 shadow 이후).
 */
import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { cookieBase } from '@/lib/auth/cookies';

export const SP_FS_COOKIE = '__Host-sp_fs';
// doc §1.1: Firebase 세션쿠키 수명 5분~2주 공식 허용, POC는 5일 고정(prod 상향은 별도 결정 필요·14일 상한).
export const FIREBASE_SESSION_MAX_AGE_SECONDS = 5 * 24 * 60 * 60;

// doc §5 Phase1 항목5(issuer별 metrics+neutral failure reason) — 실 issuer 처리 로직이 아직
// 없는 스캐폴드 단계라 지금은 reason만 중립 로깅. Phase 2+에서 issuer/firebase_uid 축으로 확장.
function logSessionFailure(reason: string): void {
  console.warn(`auth.firebase.session 실패 reason=${reason}`);
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

  // TODO(Phase 2+): ID token 검증(verifySprintableSession 계열은 세션쿠키 전용이라 별도 ID-token
  // 검증기 필요)+CSRF 이중제출+auth_time<=5분+identity resolve/provision+Firebase Admin SDK
  // 세션쿠키 실 발급+__Host-sp_fs set+sp_at/sp_rt/vault 쿠키 정리(doc §4.4 10단계) — Firebase
  // 프로젝트 프로비저닝(PO 인프라 lane) 후 채운다. 지금은 플래그가 이미 false라 여기 도달 불가.
  logSessionFailure('not_implemented');
  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'Session exchange implementation pending' } },
    { status: 501 },
  );
}

/**
 * ⚠️story e5225c0a 3차 근본(prod 쿠키 domain 불일치로 삭제 no-op) 재발 방지 — `__Host-` prefix
 * 쿠키는 브라우저 스펙(RFC 6265bis)상 Domain 속성이 있으면 Set-Cookie 자체가 거부된다. 즉
 * cookieBase()의 domain을 여기서 절대 쓰면 안 되고(써도 브라우저가 무시/거부), 그 제약이 오히려
 * 이 쿠키를 domain-drift 클래스 버그로부터 구조적으로 안전하게 만든다.
 */
export function setFirebaseSessionCookie(response: NextResponse, sessionCookieValue: string): void {
  const { secure } = cookieBase();
  response.cookies.set(SP_FS_COOKIE, sessionCookieValue, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: FIREBASE_SESSION_MAX_AGE_SECONDS,
    // domain 의도적 생략 — __Host- prefix 요건.
  });
}
