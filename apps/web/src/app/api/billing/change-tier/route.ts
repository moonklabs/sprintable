import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST /api/billing/change-tier — 유료→유료 상향(story #2880/#2906②). checkout과 같은
 * 이유로 이 프록시를 거친다(X-Org-Id 인터셉터+CSP connect-src, checkout/route.ts 참고).
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/change-tier');
}
