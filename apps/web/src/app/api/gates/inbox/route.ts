import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2054: 결재함 통합 인박스 — Gate + HitlRequest(gate_approval park) 통합 조회.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/gates/inbox');
}
