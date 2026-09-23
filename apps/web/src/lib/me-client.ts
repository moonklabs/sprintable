import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #4184(E-MOBILE-SPEED) — `GET /api/me` 요청 공유. 22곳 18파일이 각자 부르던 탓에
 * `/settings` 한 번 진입에 7회(dev·prod 라이브) 나갔다 — 한 화면이 동시에 마운트하는 여러 절이
 * 같은 요청 하나를 나눠 쓰게 한다.
 *
 * - 진행 중인 요청은 공유한다. 응답은 요청 시작부터 ME_FRESH_MS 동안 재사용한다(동시 마운트
 *   폭발을 덮는 폭 — 화면 수명 캐시가 아니다, 그 밖의 서버 측 변경은 이 창이 지나면 반영된다).
 * - 실패 응답(!ok)·네트워크 예외는 저장하지 않는다(다음 호출이 곧바로 다시 시도한다).
 * - 호출부마다 새 Response를 받는다(본문을 한 번만 읽어 두고 매번 새로 만든다) — 기존
 *   `fetchWithAuth('/api/me')` 호출부의 `.ok`/`.status`/`.json()` 모양 그대로 바꿔 끼울 수 있다.
 * - 사용자 정보가 바뀌는 자리(프로필 PATCH·계정 연결 후 갱신·org 전환·로그인/로그아웃)는
 *   `invalidateMe()` 또는 `fetchMe({ fresh: true })`로 창을 끊는다. 계정 전환은 전체
 *   새로고침이라 모듈 상태 자체가 초기화된다.
 * - 세션 생존 확인(`sse-session-guard.ts`)은 실제 네트워크가 답이어야 해서 이 함수를 안 쓴다.
 */
export const ME_FRESH_MS = 5000;

interface SharedMe { ok: boolean; status: number; body: string | null }

let entry: { promise: Promise<SharedMe>; at: number } | null = null;

// 응답을 한 번만 읽어 두고 호출부마다 새 Response를 만든다(본문은 한 번만 읽을 수 있어서).
// 본문이 JSON이 아니면 null로 두어 호출부의 `.json()`이 원래처럼 실패한다.
async function readShared(res: Response): Promise<SharedMe> {
  const status = res.status || (res.ok ? 200 : 500);
  let body: string | null = null;
  try { body = JSON.stringify(await res.json()); } catch { body = null; }
  return { ok: res.ok, status, body };
}

function toResponse(shared: SharedMe): Response {
  return new Response(shared.body, { status: shared.status, headers: { 'content-type': 'application/json' } });
}

export function fetchMe(opts: { fresh?: boolean } = {}): Promise<Response> {
  const now = Date.now();
  if (!opts.fresh && entry && now - entry.at < ME_FRESH_MS) {
    return entry.promise.then(toResponse);
  }
  const current = { promise: fetchWithAuth('/api/me').then(readShared), at: now };
  entry = current;
  current.promise.then(
    (shared) => { if (!shared.ok && entry === current) entry = null; },
    () => { if (entry === current) entry = null; },
  );
  return current.promise.then(toResponse);
}

export function invalidateMe(): void {
  entry = null;
}

// 테스트 격리 — 이 모듈 상태가 한 테스트 파일 안의 여러 테스트 사이에 새지 않게
// vitest.setup.ts가 매 테스트 전에 부른다(setup이 이 모듈을 직접 import하면 테스트 파일의
// vi.mock('@/lib/db/client')보다 먼저 진짜 모듈을 물어 버려서, 로드된 인스턴스가 스스로 등록한다).
(globalThis as Record<symbol, unknown>)[Symbol.for('sprintable.invalidateMe')] = invalidateMe;
