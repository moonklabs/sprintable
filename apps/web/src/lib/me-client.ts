import { fetchWithAuth } from '@/lib/db/client';
import { getRequestContextKey } from '@/lib/project-context-client';

/**
 * story #4184(E-MOBILE-SPEED) — `GET /api/me` 요청 공유. 22곳 18파일이 각자 부르던 탓에
 * `/settings` 한 번 진입에 7회(dev·prod 라이브) 나갔다 — 한 화면이 동시에 마운트하는 여러 절이
 * 같은 요청 하나를 나눠 쓰게 한다.
 *
 * - **진행 중인 요청만** 공유한다. 응답이 오면(성공·실패·예외 모두) 공유를 끝내고, 그 뒤 호출은
 *   다시 네트워크로 간다 — 저장해 두는 값이 없어서 프로젝트·org 전환, 프로필·2단계 인증 변경,
 *   로그인/로그아웃, 세션 만료 신호 뒤에 낡은 값이 나올 자리가 없다(무효화 목록을 관리하지
 *   않는다). PR #4548 까디르 QA 뒤 PO 실측 처방: 응답 지연 300ms로 잰 `/settings` 탭별 호출 수가
 *   5초 재사용 창과 똑같이 1회라 창을 뺐다.
 * - 합류는 **요청 맥락(인터셉터가 싣는 org·project)이 같을 때만**. 전환 직전에 출발한 요청이
 *   아직 진행 중이어도 전환 뒤 호출은 거기 붙지 않고 새로 보낸다(PR #4548 까디르 재QA P3, PO 처방 —
 *   무효화 호출 대신 구조로).
 * - 호출부마다 새 Response를 받는다(본문을 한 번만 읽어 두고 매번 새로 만든다) — 기존
 *   `fetchWithAuth('/api/me')` 호출부의 `.ok`/`.status`/`.json()` 모양 그대로 바꿔 끼울 수 있다.
 * - 세션 생존 확인(`sse-session-guard.ts`)은 공유 없이 매번 실제로 물어야 해서 이 함수를 안 쓴다.
 */

interface SharedMe { ok: boolean; status: number; body: string | null }

let inFlight: { key: string; promise: Promise<SharedMe> } | null = null;

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
  if (!inFlight || inFlight.key !== key) {
    const current = { key, promise: fetchWithAuth('/api/me').then(readShared) };
    inFlight = current;
    const release = () => { if (inFlight === current) inFlight = null; };
    current.promise.then(release, release);
  }
  return inFlight.promise.then(toResponse);
}

// 테스트 격리 — 한 테스트가 끝나지 않은 요청을 남기면 다음 테스트의 첫 호출이 그걸 물 수 있다.
// vitest.setup.ts가 매 테스트 전에 부른다(setup이 이 모듈을 직접 import하면 테스트 파일의
// vi.mock('@/lib/db/client')보다 먼저 진짜 모듈을 물어 버려서, 로드된 인스턴스가 스스로 등록한다).
(globalThis as Record<symbol, unknown>)[Symbol.for('sprintable.resetMeClient')] = () => { inFlight = null; };
