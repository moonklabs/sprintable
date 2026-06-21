import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S34: line config version 리스트(history·GET ?entity_type=&project_id=) + 새 draft 생성(POST).
// BE /api/v2/workflow-line-config/versions (#1647 list + S2 create). admin·raw passthrough(url.search 자동전달).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/workflow-line-config/versions');
}
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/workflow-line-config/versions');
}
