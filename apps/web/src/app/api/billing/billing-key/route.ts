import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * story #2989 — 결제수단(빌링키) 조회+셀프서브 삭제.
 * GET → `GET /api/v2/org-billing-keys`(등록된 카드가 있으면 마스킹 정보, 없으면 data:null).
 * DELETE → `DELETE /api/v2/org-billing-keys`(Toss 실 폐기+DB 정리 — revoke_billing_key).
 * 활성 유료 구독이 있으면 BE가 409(active_subscription_blocks_revoke)로 거부한다.
 */
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-billing-keys');
}

export async function DELETE(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-billing-keys');
}
