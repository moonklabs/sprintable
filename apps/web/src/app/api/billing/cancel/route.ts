import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST/DELETE /api/billing/cancel — 구독 취소 예약(story #2882)/철회. checkout과 같은
 * 이유로 이 프록시를 거친다(X-Org-Id 인터셉터+CSP connect-src, checkout/route.ts 참고).
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/cancel');
}

export async function DELETE(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/cancel');
}
