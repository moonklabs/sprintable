import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';
import { withRouteTiming } from '@/lib/server-timing';

/**
 * GET /api/billing/status — story #40659941(#2728 픽셀 검증 블로커). billing-tab.tsx가
 * `NEXT_PUBLIC_FASTAPI_URL`로 브라우저에서 직접 fetch하던 것을 이 프록시로 수렴한다 —
 * checkout/customer-key 프록시(같은 디렉토리)와 동일 이유: X-Org-Id 인터셉터(same-origin
 * /api/* 전용, #2497)+CSP connect-src(브라우저가 백엔드 origin에 직접 못 붙음, 이 스토리의
 * 실 원인) 둘 다 프록시 경유일 때만 적용된다.
 */
// story #4299 AC2 — 라우트 전체 계측(합계 · bff_pre · 인증 /me 포함 모든 백엔드 호출 · dev 전용 · 꺼지면 그대로 호출).
export const GET = withRouteTiming('billing-status', async (request: Request): Promise<Response> => {
  return proxyToFastapiWrapped(request, '/api/v2/billing/status');
});
