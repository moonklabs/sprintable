import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

/**
 * POST /api/billing/checkout — Toss 위젯 카드 인증(authKey) 완료 후 구독 체크아웃(#2510).
 * FastAPI로 직접 fetch하지 않고 이 프록시를 거치는 이유 — #2497에서 고친 X-Org-Id 브라우저
 * 인터셉터(same-origin /api/* 요청에만 주입)가 여기서만 적용된다. 결제처럼 잘못된 org로
 * 새면 안 되는 호출에 그 안전망을 반드시 태운다.
 *
 * proxyToFastapiWrapped — 성공 바디만 `{data}`로 재포장(에러는 BE 글로벌 핸들러가 이미
 * `{error:{code,message}}`로 감싸 그대로 통과) — 이 레포 envelope 관례와 일치.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/checkout', {
    // story #4320(까디르 QA ③) — 결제 시도를 만드는 요청(authKey를 싣는다) — 브라우저가 끊어도 시도 행까지는 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
    // story #4335 — 시작은 곧바로 답한다(청구는 응답 뒤 작업) · 결과는 시도 조회(/api/billing/attempts/{id}). 근거는 표.
    timeoutMs: LONG_ROUTES.billingCheckout.bffMs,
  });
}
