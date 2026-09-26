import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapiWithParams(request, '/api/v2/team-members/[id]/api-key', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapiWithParams(request, '/api/v2/team-members/[id]/api-key', { id }, {
      // story #4320(까디르 QA ③) — 구성원 API 키를 새로 낸다(한 번만 보여 주는 값) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
      timeLimitOnly: true,
    });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
