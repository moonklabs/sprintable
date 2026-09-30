import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 (나) — GET /api/v2/desktop/recipes/for-new-org 프록시(사람 세션 · 조직 없는 사람 · 설계 doc 9a4cb445 §9): 새 조직이
// 시작할 수 있는 플랫폼 프리셋과 그 줄. 모양은 /api/desktop/recipes(4831)와 같아 같은 그리기 코드가 그린다.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/recipes/for-new-org');
}
