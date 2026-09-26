import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

/**
 * GET /api/billing/attempts/{id} — story #4335. 결제 시도(checkout · change-tier) 상태 조회. 결제 결과는 이 조회로 확정한다
 * (끊긴 뒤 · 새로고침 · 재진입 모두 재요청이 아니라 조회). 서버가 진행 중인데 멈춘 시도는 여기서 이어받아 마무리한다.
 * checkout/route.ts와 같은 이유로 이 프록시를 거친다(X-Org-Id 인터셉터 · CSP connect-src).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapiWrapped(request, `/api/v2/org-subscriptions/attempts/${encodeURIComponent(id)}`, {
    // 멈춘 시도를 이어받아 확정(구독 전이 · 부분 환불)하는 조회일 수 있다 — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
    timeoutMs: LONG_ROUTES.billingAttemptStatus.bffMs,
  });
}
