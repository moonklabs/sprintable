import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);


    const _r = await proxyToFastapiWithParams(request, '/api/v2/meetings/[id]/recording', { id });
    if (!_r.ok) return _r;
    return _r;
  } catch (err: unknown) { return handleApiError(err); }
}
