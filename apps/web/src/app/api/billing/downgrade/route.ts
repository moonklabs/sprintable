import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST/DELETE /api/billing/downgrade — 하향 예약(story #2881)/철회. checkout과 같은
 * 이유로 이 프록시를 거친다(X-Org-Id 인터셉터+CSP connect-src, checkout/route.ts 참고).
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/downgrade');
}

export async function DELETE(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/downgrade');
}
