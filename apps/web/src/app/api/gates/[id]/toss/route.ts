import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3084 층3 — 결재 카드 토스 프록시. BE POST /api/v2/gates/{id}/toss
// {target_conversation_id} → 갱신된 GateResponse(멱등 — 이미 있으면 200 무변화). 인가
// (requester/designated 본인만·403)·대상 참여자 검증(422)·pending 가드(409)는 BE 강제,
// 이 라우트는 순수 프록시(delegate 라우트와 동형).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/toss`);
}
