import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #2258 — 검증요청: 제네릭 게이트 생성(POST /api/gates)은 이미 있었는데 story 화면에서
// 부르는 곳이 0곳이었다(member_id/role_id를 client가 몰라 실질적으로 막혀 있었음). BE가
// role_id를 서버에서 해소하는 얇은 래퍼(stories.py::request_verification)를 그대로 프록시.
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/request-verification', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
