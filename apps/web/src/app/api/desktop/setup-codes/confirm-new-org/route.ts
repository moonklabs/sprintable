import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 (나) — POST /api/v2/desktop/setup-codes/confirm-new-org 프록시(사람 세션 · 조직 없는 사람만 · 설계 doc 9a4cb445).
// body = {code, recipe_id, roles:[{role, runtime}], workdir_hint, org_name, project_name} — 조직 · 프로젝트 칸은 없다(서버가 새로 만든
// 것만 쓴다 · extra=forbid). 설정 코드는 본문으로만. 판단(조직 0행 · 대기 초대 · 이메일 · 한도 · 만료)은 BE가 한다.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setup-codes/confirm-new-org');
}
