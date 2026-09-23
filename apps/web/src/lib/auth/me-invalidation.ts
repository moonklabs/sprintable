/**
 * story #4184(배포 18 라이브 AC1 미달 뒤) — `fetchMe()` 결과 재사용의 무효화 신호. `lib/db/client.ts`
 * (fetchWithAuth·로그인/로그아웃)가 쏘고 `lib/me-client.ts`가 받는다 — 두 모듈이 서로를 import하지 않게
 * 이 파일이 가운데에 선다(me-client는 이미 db/client를 import한다).
 *
 * 쏘는 자리(이 함수를 부르는 곳이 곧 «캐시가 낡을 수 있는 순간»의 전수):
 * - 로그인·가입·토큰 갱신 성공(callAuthRoute) · 로그아웃 — 인증 주체가 바뀔 수 있다.
 * - fetchWithAuth의 쓰기 요청(GET·HEAD 아님) — 프로필·2단계 인증·비밀번호·연결 계정·역할 등 `/api/me`
 *   내용을 바꾸는 요청을 하나하나 목록으로 관리하지 않고, 쓰기는 전부 무효화로 본다(목록 누락이 곧 낡은 값).
 * - 세션 만료 신호 — 만료 뒤 캐시된 200을 돌려주지 않게. fetchWithAuth의 401은 늘 토큰 갱신으로 이어지고, 갱신
 *   성공은 위 callAuthRoute가, 실패(오류 응답·예외)는 이 신호가 무효화하므로 401 자리에 따로 두지 않는다.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onMeInvalidated(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function invalidateMeCache(): void {
  for (const cb of listeners) cb();
}
