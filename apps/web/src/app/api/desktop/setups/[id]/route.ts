import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4427 — GET /api/v2/desktop/setups/{id} 프록시(4826 · org owner/admin 사람 세션): 설정 하나의 상태와 신호(진행 표시 ①②③ ·
// 폴더 대체 · ⑥ · ⑦). 설정 id는 코드가 아니다(이벤트 session_id와 같은 값) — 경로에 실어도 된다. 모양만 여기서 거른다.
const SETUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!SETUP_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/desktop/setups/${id}`);
}
