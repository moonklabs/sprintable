import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4711 AC4 — POST /api/v2/desktop/setup-codes/confirm-solo-new-org 프록시(사람 세션 · 조직이 없는 사람만).
// body = {code, runtime, org_name, project_name} — 조직 · 프로젝트 id 칸은 없다(서버가 새로 만든 것만 쓴다 · extra=forbid).
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setup-codes/confirm-solo-new-org');
}
