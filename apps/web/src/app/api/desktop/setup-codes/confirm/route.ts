import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 — POST /api/v2/desktop/setup-codes/confirm 프록시(4424 · org owner/admin 사람 세션).
// body = {code, project_id, recipe_id, roles:[{role, runtime}], workdir_hint}. 설정 코드는 본문으로만 — 어떤 경로에도 싣지 않는다
// (요청 줄은 접근 · 오류 로그에 남는다 · 까디르 4825 · PO 09:45Z). 판단(만료 · 이미 확인됨 · 권한)은 BE가 한다.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setup-codes/confirm');
}
