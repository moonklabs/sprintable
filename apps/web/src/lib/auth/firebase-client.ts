'use client';

/**
 * story a0118204(E-AUTH-REBUILD Phase2-FE-S1·doc firebase-auth-identity-platform-migration-poc
 * §1.1): Firebase 클라 SDK primary sign-in 초기화. **플래그 뒤·all off 시 무해** — Firebase
 * 프로젝트 config(non-prod)가 아직 프로비저닝 전이라(오르테가군 확認), config 부재 시 절대
 * throw하지 않고 null을 반환한다(호출부가 이 null을 "Firebase 비활성"으로 처리).
 *
 * doc §1.1 4번: 클라 persistence는 반드시 NONE — 서버 세션쿠키(`__Host-sp_fs`)가 SSOT이고
 * 클라이언트 Firebase SDK 자체 세션을 남기지 않는다(교환 성공 직후 즉시 signOut, 호출부 책임).
 */
import { type FirebaseApp, initializeApp, getApps } from 'firebase/app';
import { type Auth, getAuth, inMemoryPersistence, setPersistence } from 'firebase/auth';

export const FIREBASE_AUTH_ENABLED = process.env['NEXT_PUBLIC_FIREBASE_AUTH_ENABLED'] === 'true';

function readConfig(): Record<string, string> | null {
  const apiKey = process.env['NEXT_PUBLIC_FIREBASE_API_KEY'];
  const authDomain = process.env['NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'];
  const projectId = process.env['NEXT_PUBLIC_FIREBASE_PROJECT_ID'];
  const appId = process.env['NEXT_PUBLIC_FIREBASE_APP_ID'];
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

let _app: FirebaseApp | null | undefined;

/** config 미프로비저닝(PO 인프라 lane 착지 전)이면 null — 절대 throw 안 함(스캐폴드 무해 원칙). */
function getFirebaseApp(): FirebaseApp | null {
  if (_app !== undefined) return _app;
  const config = readConfig();
  if (!config) {
    _app = null;
    return null;
  }
  _app = getApps()[0] ?? initializeApp(config);
  return _app;
}

/**
 * doc §1.1 4번(persistence=NONE)의 실제 구현 지점 — 서버 세션쿠키 SSOT 원칙상 브라우저에
 * Firebase 자체 세션을 지속시키지 않는다. `inMemoryPersistence`가 Firebase SDK의 "세션 없음"
 * 표현(로그인 도중 탭 이동 시에만 유지, 새로고침/재방문 시 소멸).
 */
export async function getFirebaseAuth(): Promise<Auth | null> {
  const app = getFirebaseApp();
  if (!app) return null;
  const auth = getAuth(app);
  await setPersistence(auth, inMemoryPersistence);
  return auth;
}

// 테스트 전용 — 모듈 싱글톤이 테스트 간 상태를 누출하지 않도록.
export function _resetFirebaseAppForTests(): void {
  _app = undefined;
}
