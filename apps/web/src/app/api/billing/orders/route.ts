import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * GET /api/billing/orders — story #3209(PR-1). status/route.ts와 동일 프록시 이유(X-Org-Id
 * 인터셉터+CSP connect-src는 same-origin /api/* 경유일 때만 적용).
 */
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/billing/orders');
}
