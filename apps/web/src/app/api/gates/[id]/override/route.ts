import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

// E-DG S33: owner 결재 강제(override) 프록시. BE POST /api/v2/gates/{id}/override {decision, reason}
// — owner-only(is_org_owner 403·admin 아님)·gate.status→approved/rejected 강제·gate_overridden(bypassed_sod).
// 디디 BE #1645 design-first 병렬·머지 후 정합. void/transition 동형 raw passthrough.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/override`, {
    // story #4320(까디르 QA ①) — 대신 결재도 전이와 같은 발행 경로 — 시한은 표 한 곳(bff-route-timeouts · 근거 백엔드 파일:줄).
    timeoutMs: LONG_ROUTES.gateTransition.bffMs,
  });
}
