import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST /api/billing/customer-key — Toss 위젯 인증 시작 前 서버발급 customerKey 조회/발급(#2510).
 * customerKey는 FE가 생성하지 않는다 — C1 규율(추측 불가능한 값을 서버가 발급·org 매핑)을
 * 그대로 따른다(PO 확定, 2026-08-07). 백엔드 계약 확定(#2512, PR #2890/#2892) —
 * `POST /api/v2/org-billing-keys/customer-key`(바디 없음) → `{customer_key}`, 멱등.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-billing-keys/customer-key');
}
