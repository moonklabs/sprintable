import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3293(축2-ⓒ §B) — GET /api/v2/events/definitions/{id}/bindings 프록시. query
// project_id(선택) 그대로 전달(url.search 자동 forward). 응답 {bindings: {stage: agent_id}}.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/events/definitions/${id}/bindings`);
}
