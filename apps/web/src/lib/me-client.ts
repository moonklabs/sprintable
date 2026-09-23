import { fetchWithAuth } from '@/lib/db/client';
import { getRequestContextKey } from '@/lib/project-context-client';
import { onMeInvalidated } from '@/lib/auth/me-invalidation';

/**
 * story #4184(E-MOBILE-SPEED) — `GET /api/me` 공유. 22곳 18파일이 각자 부르던 탓에 `/settings` 한 번 진입에
 * 7회(dev·prod 라이브) 나갔다.
 *
 * - **진행 중 요청 합류 + 성공 결과 재사용(요청 맥락별 · 최대 ME_REUSE_TTL_MS · 탭이 다시 보이면 버림).** 배포 18 라이브(PO CDP, 하드 로드)에서
 *   진행 중 공유만으로는 3회였다 — 설정 화면은 loadContext가 끝난 뒤 절들이 차례로 마운트해 두 번째 호출이 첫
 *   요청이 끝난 뒤(~1초 뒤) 나가서 합류할 요청이 없었다(PR #4548의 jsdom 측정은 모든 절이 동시에 마운트해 이 순서를
 *   못 봤다). 그래서 성공 응답(2xx)을 맥락 키별로 들고 있다가 같은 맥락의 다음 호출에 돌려준다. 실패 응답은 들지 않는다.
 * - **무효화**(`lib/auth/me-invalidation.ts`가 쏘는 자리 전수): 로그인·가입·토큰 갱신·로그아웃 · fetchWithAuth의 쓰기
 *   요청 전부 · 401 · 세션 만료 신호. 무효화는 진행 중 요청도 떼어 내고 세대 번호를 올린다 — 무효화 전에 출발한
 *   요청이 뒤늦게 도착해도 그 값은 저장하지 않는다(쓰기 직전 값이 쓰기 뒤 캐시로 남는 경합 차단). 까디르 QA가
 *   5초 창 때 잡은 ① 무효화 누락 ② 만료 뒤 캐시 200을 이 두 장치가 닫는다.
 * - 합류·재사용은 **요청 맥락(인터셉터가 싣는 org·project)이 같을 때만**. 전환 뒤 호출은 새로 보낸다(무효화 호출 없이 구조로).
 * - 호출부마다 새 Response를 받는다(본문을 한 번만 읽어 두고 매번 새로 만든다) — 기존 `fetchWithAuth('/api/me')`
 *   호출부의 `.ok`/`.status`/`.json()` 모양 그대로.
 * - 세션 생존 확인(`sse-session-guard.ts`)은 캐시가 아니라 매번 실제로 물어야 해서 이 함수를 안 쓴다.
 */

interface SharedMe { ok: boolean; status: number; body: string | null }

let inFlight: { key: string; promise: Promise<SharedMe> } | null = null;
let resolved: { key: string; value: SharedMe; at: number } | null = null;
let generation = 0;

// PR #4565 PO 보강 — 재사용 값에 수명을 둔다. 무효화 신호(로그인·로그아웃·쓰기·만료)가 없어도 다른 세션에서 관리자가
// 바꾼 역할·멤버십·프로필이 이 탭에 몇 시간씩 안 보이는 부류(예전엔 화면을 새로 열 때마다 새 값)를 막는다. 설정 화면의
// 두 호출 간격(~2.7초, 배포 18 CDP)은 이 안에 들어 AC1(진입 1회)은 그대로다.
export const ME_REUSE_TTL_MS = 30_000;

function invalidate(): void {
  generation += 1;
  inFlight = null;
  resolved = null;
}
onMeInvalidated(invalidate);

// 탭이 다시 보이면(다른 탭·앱에서 돌아옴) 그동안 바뀐 역할·멤버십을 새로 읽게 버린다.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') invalidate();
  });
}

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

export function fetchMe(): Promise<Response> {
  const key = getRequestContextKey();
  if (resolved && resolved.key === key && Date.now() - resolved.at < ME_REUSE_TTL_MS) {
    return Promise.resolve(toResponse(resolved.value));
  }
  if (!inFlight || inFlight.key !== key) {
    const startedAt = generation;
    const current = { key, promise: fetchWithAuth('/api/me').then(readShared) };
    inFlight = current;
    const settle = (value: SharedMe | null) => {
      if (inFlight === current) inFlight = null;
      // 무효화(세대 변경) 뒤에 도착한 값·실패 응답은 들지 않는다.
      if (value && value.ok && startedAt === generation) resolved = { key, value, at: Date.now() };
    };
    current.promise.then(settle, () => settle(null));
  }
  return inFlight.promise.then(toResponse);
}

// 테스트 격리 — 한 테스트가 끝나지 않은 요청을 남기면 다음 테스트의 첫 호출이 그걸 물 수 있다.
// vitest.setup.ts가 매 테스트 전에 부른다(setup이 이 모듈을 직접 import하면 테스트 파일의
// vi.mock('@/lib/db/client')보다 먼저 진짜 모듈을 물어 버려서, 로드된 인스턴스가 스스로 등록한다).
(globalThis as Record<symbol, unknown>)[Symbol.for('sprintable.resetMeClient')] = invalidate;
