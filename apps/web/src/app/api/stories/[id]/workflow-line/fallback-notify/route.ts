import { handleApiError } from '@/lib/api-error';
import { ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// E-DG S12 ② — fallback "notify human owner" 액션 thin 프록시.
// ⚠️ 갭2 PROVISIONAL: 디디/산티아고 BE 액션(`dispatch_notification` 기반) 신설 후(디디 S19 후)
//    실 경로/body 정합 필요. BE 미구현 시 404 → FE 상태머신이 '실패→재시도'로 graceful 처리.
// 계약 전제(BE 보장): idempotent · 200 "이미 통지됨" · status 안 되돌림(재호출 안전).
// raw passthrough — workflow-line 도메인 envelope 일관(.data 아님).
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    return await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/workflow-line/fallback-notify', { id });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
