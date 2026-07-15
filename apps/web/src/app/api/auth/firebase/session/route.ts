/**
 * story 386a8b56(E-AUTH-REBUILD M2 Phase1-S3·doc §4.4): POST /api/auth/firebase/session 스캐폴드.
 * FIREBASE_AUTH_ISSUE_SESSION=false(기본) 동안은 501 — Firebase Admin SDK 초기화/실 ID token
 * 검증/identity resolve 로직은 이 플래그가 켜지고 Firebase 프로젝트가 준비된 후 Phase 2+에서
 * 채운다(doc §5 Phase 1 스코프=검증기+스키마까지, 실 발급은 Phase 2 shadow 이후).
 *
 * ⚠️까심 REQUEST_CHANGES(2026-07-15, 정당한 build blocker): Next.js route.ts는 HTTP 메서드
 * (GET/POST/...)+route segment config만 export 허용 — 임의 심볼 export는 next build 타입
 * 에러. 쿠키 상수/헬퍼(SP_FS_COOKIE·setFirebaseSessionCookie 등)는 lib/auth/firebase-session.ts
 * 로 이관, 여기선 import만.
 */
import { NextResponse } from 'next/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';

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
  // 세션쿠키 실 발급+setFirebaseSessionCookie() 호출+sp_at/sp_rt/vault 쿠키 정리(doc §4.4 10단계)
  // — Firebase 프로젝트 프로비저닝(PO 인프라 lane) 후 채운다. 지금은 플래그가 이미 false라
  // 여기 도달 불가.
  logSessionFailure('not_implemented');
  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'Session exchange implementation pending' } },
    { status: 501 },
  );
}
