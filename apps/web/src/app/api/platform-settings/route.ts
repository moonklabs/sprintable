import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * GET /api/platform-settings — story #40659941(#2728 픽셀 검증 블로커). billing-tab.tsx가
 * `NEXT_PUBLIC_FASTAPI_URL`로 브라우저에서 직접 fetch하던 것을 이 프록시로 수렴한다(billing/
 * status 프록시와 동일 이유 — X-Org-Id 인터셉터+CSP connect-src 둘 다 프록시 경유 전용).
 * mutation은 공개 API에 없음(story #2728 — internal-api require_operator 전용) — 이 프록시도
 * GET만 노출.
 */
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/platform-settings');
}
