import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapiWithParams(request, '/api/v2/team-members/[id]/avatar/upload-url', { id });
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
