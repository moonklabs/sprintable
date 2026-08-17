import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/visual-artifacts/{id}/backlinks — story #2721(아티팩트·원장 1급화 1단): 이
 * artifact를 가리키는 것들(chat_message/doc/story source) 목록. stories.py의 backlinks
 * 프록시와 동형(BE convention-A {data,meta} 언랩 — activities/route.ts 이중포장 사고와 같은
 * 자리라 처음부터 raw json.data ?? json 패턴으로 짓는다) — 이 파일의 다른 GET들처럼
 * `getAuthContext`+`proxyToFastapi`(단순 문자열 경로, `[id]` 세그먼트 치환 불요).
 */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/visual-artifacts/${id}/backlinks`);
    if (!_r.ok) return _r;
    const beJson = (await _r.json()) as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
