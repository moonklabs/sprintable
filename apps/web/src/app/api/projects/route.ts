import { handleApiError } from '@/lib/api-error';
import { ApiErrors, apiSuccess } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 조직 프로젝트 목록 */
export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST — 프로젝트 생성 (org_id는 auth context에서 자동 주입) */
export async function POST(request: Request) {
  try {
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    // 온보딩처럼 클라이언트가 org_id를 명시한 경우 그대로 신뢰; FastAPI가 소속 Org 권한 검증
    const enriched = { ...body, org_id: body.org_id ?? me.org_id };

    const syntheticRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(enriched),
    });
    const _r = await proxyToFastapi(syntheticRequest, '/api/v2/projects');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
