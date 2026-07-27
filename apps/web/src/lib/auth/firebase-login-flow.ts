'use client';

/**
 * story a0118204(E-AUTH-REBUILD Phase2-FE-S1·doc §1.1/§4.4): Firebase 클라 sign-in→ID토큰→
 * BFF 세션교환(`POST /api/auth/firebase/session`, 디디 story 386a8b56 스캐폴드) 클라측 오케스트레이션.
 *
 * ⚠️서버 플래그(`FIREBASE_AUTH_ISSUE_SESSION`)가 꺼져있는 동안 BFF는 항상 501을 반환한다(디디
 * route.ts 확認 — 이 파일이 아무리 호출돼도 실 세션 발급/legacy 쿠키 정리는 일어나지 않는다).
 * 클라측 플래그(`NEXT_PUBLIC_FIREBASE_AUTH_ENABLED`)는 UX 노출(버튼 렌더) 게이트일 뿐 권한이
 * 아니다 — 실 발급 권위는 서버 플래그(S1 쿠키캐시 설계 때 확立한 "UX 힌트≠권한" 패턴과 동형).
 */
import { signInWithEmailAndPassword } from 'firebase/auth';
import { getFirebaseAuth } from './firebase-client';

export interface FirebaseAuthResult {
  ok: boolean;
  error: { code: string; message: string } | null;
}

const DISABLED_ERROR = { code: 'FIREBASE_DISABLED', message: 'Firebase auth is not configured' } as const;

/**
 * doc §1.1 1-2번(클라 SDK sign-in+ID토큰 발급)+§4.4(세션교환 요청)+§1.1 5번(교환 성공 후
 * persistence=NONE 하에서 signOut) 순서 그대로. 실패 시 어떤 단계든 signOut 없이 즉시 반환
 * (교환 미완료 상태에서 로컬 Firebase 세션을 지속시키지 않기 위해 — Firebase SDK가
 * inMemoryPersistence라 새로고침 시 어차피 소멸하지만, 명시적 정리가 정직함).
 */
export async function signInAndExchangeFirebaseSession(email: string, password: string): Promise<FirebaseAuthResult> {
  const auth = await getFirebaseAuth();
  if (!auth) return { ok: false, error: DISABLED_ERROR };

  let idToken: string;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    idToken = await credential.user.getIdToken();
  } catch {
    return { ok: false, error: { code: 'FIREBASE_SIGNIN_FAILED', message: 'Firebase sign-in failed' } };
  }

  // story 132e7204(S4) route.ts는 body.id_token(snake_case)을 읽는다 — camelCase로 보내면
  // 항상 undefined→400 INVALID_REQUEST(S1 스캐폴드 시절엔 501로 가려져 있어 안 드러났던 계약
  // 불일치, S4 재검증 그라운딩에서 직접 발견).
  const res = await fetch('/api/auth/firebase/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: idToken }),
  }).catch(() => null);

  if (!res) return { ok: false, error: { code: 'NETWORK_ERROR', message: 'Session exchange request failed' } };

  const json = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null;

  if (!res.ok) {
    // doc §1.1 5번: 서버 세션쿠키 SSOT — 교환 실패 시 클라 Firebase 세션을 남기지 않는다.
    await auth.signOut().catch(() => undefined);
    return { ok: false, error: json?.error ?? { code: 'SESSION_EXCHANGE_FAILED', message: 'Session exchange failed' } };
  }

  // doc §1.1 5번: 교환 성공 후 즉시 signOut — 서버 __Host-sp_fs 쿠키가 SSOT.
  await auth.signOut().catch(() => undefined);
  return { ok: true, error: null };
}
