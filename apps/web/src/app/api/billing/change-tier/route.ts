import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

/**
 * POST /api/billing/change-tier — 유료→유료 상향(story #2880/#2906②). checkout과 같은
 * 이유로 이 프록시를 거친다(X-Org-Id 인터셉터+CSP connect-src, checkout/route.ts 참고).
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/change-tier', {
    // story #4320(까디르 QA ③) — 결제 시도를 만드는 요청 — 브라우저가 끊어도 시도 행까지는 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
    // story #4335 — 시작은 곧바로 답한다(청구 · 부분 환불은 응답 뒤 작업) · 결과는 시도 조회. 근거는 표.
    timeoutMs: LONG_ROUTES.billingChangeTier.bffMs,
  });
}
