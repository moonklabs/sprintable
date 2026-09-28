import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4249 — POST /api/v2/events/definitions/{id}/complete-stage 프록시. body = {project_id, work_item_type,
// work_item_id, stage}. 지금 stage를 맡은 멤버가 끝내면 다음 stage 이벤트를 그 멤버 명의로 낸다(BE 검증 · 발행 코어 그대로).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/events/definitions/${id}/complete-stage`);
}
