import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4565 — GET /api/v2/desktop/setup/agents?project_id= 프록시(사람 세션 · owner/admin): 셋업이 한 역할에 붙일 수 있는
// 이 조직의 이미 있는 에이전트(이 프로젝트 · 데스크톱 런타임)와 각자의 살아 있는 키 수 · 마지막 연결 시각. 키 값은 없다.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setup/agents');
}
