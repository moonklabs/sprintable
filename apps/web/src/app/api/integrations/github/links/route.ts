import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-GHAPP Bot-L.2: PR↔story 명시연결 프록시. raw passthrough(proxyToFastapi) — body/query 검증·strip 0
// (BE가 단일 진실: org-scope·anti-IDOR generic 404). zod 미도입=새 필드 무음 strip 회귀 클래스 원천 제거.

/** GET /api/integrations/github/links?story_id= — story의 연결 PR 리스트(url.search로 query forward) */
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/integrations/github/links');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST /api/integrations/github/links — 명시 연결 추가(source=explicit·confidence=high). body=repo+pr(+story_id) */
export async function POST(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, '/api/v2/integrations/github/links');
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json(), undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
