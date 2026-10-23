import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4711 — POST /api/v2/desktop/setup-codes/confirm-solo 프록시(사람 세션 · 처음 셋업 세 걸음의 «시작»).
// body = {code, runtime, project_id | project_name, workdir_hint?, tools?} — 폴더 경로 칸은 없다(서버는 경로를 받지 않는다).
// 설정 코드는 본문으로만. 판단(능력 · 조직 owner/admin · 프로젝트 접근 · 한도 · 만료)은 BE가 한다.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/setup-codes/confirm-solo');
}
