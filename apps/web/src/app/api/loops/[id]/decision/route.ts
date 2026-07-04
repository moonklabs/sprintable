import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/loops/[id]/decision → FastAPI POST /api/v2/loops/{id}/decision.
// human-only(403 DECISION_HUMAN_ONLY)·status='deciding' 강제(409)·슬롯 원자성(422) — 전부 BE 판정,
// 이 라우트는 순수 passthrough(에러 envelope도 BE 그대로 전달).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/loops/${id}/decision`);
}
