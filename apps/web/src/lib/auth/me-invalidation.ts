/**
 * story #4184(배포 18 라이브 AC1 미달 뒤) — `fetchMe()` 결과 재사용의 무효화 신호. `lib/db/client.ts`
 * (로그인/로그아웃)·`lib/project-context-client.ts`(쓰기 관문)가 쏘고 `lib/me-client.ts`가 받는다 — 두 모듈이 서로를 import하지 않게
 * 이 파일이 가운데에 선다(me-client는 이미 db/client를 import한다).
 *
 * 쏘는 자리(이 함수를 부르는 곳이 곧 «캐시가 낡을 수 있는 순간»의 전수):
 * - 로그인·가입·토큰 갱신 성공(callAuthRoute) · 로그아웃 — 인증 주체가 바뀔 수 있다.
 * - same-origin `/api/` 쓰기 요청(GET·HEAD 아님) 전부 — `project-context-client`의 window.fetch 인터셉터 한 곳에서
 *   시작·완료 두 번(raw fetch·fetchWithAuth·Request 입력 모두 그 관문을 지난다). 프로필·2단계 인증·비밀번호·연결 계정·
 *   역할·전환 등 `/api/me` 내용을 바꾸는 요청을 목록으로 관리하지 않고 쓰기는 전부 무효화로 본다(목록 누락이 곧 낡은 값).
 *   PR #4565 까디르 재QA: 예전엔 fetchWithAuth 쓰기만 봐서 raw fetch 쓰기(2FA 켜기 등)가 캐시를 안 버렸다.
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
