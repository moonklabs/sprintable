import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4075(AC1/AC6) — GET /api/v2/events/definitions/start-candidates 프록시. query
// project_id(필수)·work_item_type(필수)·work_item_id(필수) 그대로 전달(url.search 자동
// forward). 응답 {candidates:[{definition_id,key,name,first_stage,role_bound,started,
// conversation_id,message_id}]} — raw passthrough(publish-history/bindings와 동일 관례).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/definitions/start-candidates');
}
