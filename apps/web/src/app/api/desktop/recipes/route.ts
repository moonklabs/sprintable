import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 — GET /api/v2/desktop/recipes 프록시(4831 · 사람 세션): 데스크톱 설정이 시작할 수 있는 레시피와 각 레시피의 설정 역할 줄.
// 줄은 confirm이 검사하는 같은 함수(`setup_role_rows`)로 서버가 셈한다 — 웹은 그대로 그린다(두 곳에서 따로 세던 규칙이 어긋남의 뿌리였다).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/recipes');
}
