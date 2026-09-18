import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3288(축2-ⓐ) — POST /api/v2/events/definitions/{id}/apply 프록시. body =
// {project_id?, role_mapping}. recipe_role_bindings upsert(BE 검증체인 그대로 통과 —
// has_project_access·stage_metadata 키·org 스코프 agent 검증).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/events/definitions/${id}/apply`);
}
