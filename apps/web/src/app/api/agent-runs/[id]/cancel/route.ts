import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3961(BE, PR #4364·PO PASS·미착지) — 정지 요청 프록시. BE POST
// /api/v2/agent-runs/{id}/cancel {reason?: string|null} → AgentRunResponse
// (status=cancel_requested). gates/[id]/hold/route.ts와 동형 raw passthrough
// (권한·취소가능 상태 판정은 BE 전담 — 이 프록시는 헤더/세션만 얹는다).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/agent-runs/${id}/cancel`);
}
