import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #2272 — 형제(fallback-notify)는 이미 화면(stuck-handoff-section.tsx)에서 불리는데
// withdraw는 프록시 라우트 자체가 없었다(전수 정정 — 이전 보고와 달리 실제로는 "이미 파 둔
// 라우트"가 아니라 신설이 필요했다). 형제와 동일 틀(proxyToFastapiWithParams) 그대로 사용.
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/workflow-line/withdraw', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
