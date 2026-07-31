import { NextResponse } from 'next/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/stories/{id}/references?direction=outgoing — story #2265(C-7): 이 스토리가
 * 가리키는 참조 목록(지금은 proof form만 실사용). BE(list_references)는 convention-A
 * ({data,meta})라 raw json.data ?? json 언랩 패턴으로 짓는다(backlinks/route.ts와 동형 —
 * #2247/#2564 이중포장 사고 재발 금지).
 *
 * story #2269(C-11) AC0-2 축B(2026-07-29): BE가 `data`의 형제 필드로 얹는
 * `bare_number_targets`(번호→story_id 매핑, render-time #<번호> 치환용)를 `apiSuccess(beJson.
 * data ?? beJson, ...)` 언랩 패턴 그대로 두면 조용히 버려진다(#2315 route.ts와 같은 함정 —
 * 정책 7.3의 `{data, error, meta}` 삼종엔 그 자리가 없다). `bare_number_targets`가 있을 때만
 * NextResponse.json으로 직접 형제 필드를 싣는다(정책 7.3 의도적 예외, #2315 route.ts와 동일
 * 근거 — `data` 배열 안에 섞으면 참조 목록 타입이 오염된다). */
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/references', { id });
    if (!_r.ok) return _r;
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta; bare_number_targets?: Record<string, string> };
    if (beJson.bare_number_targets) {
      return NextResponse.json({
        data: beJson.data ?? beJson,
        error: null,
        meta: beJson.meta ?? null,
        bare_number_targets: beJson.bare_number_targets,
      });
    }
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

/** POST /api/stories/{id}/references — story #2265(C-7) PR1b: 대화 인용(proof) 저장.
 * BE는 지금 target_type="chat_message"·form="proof" 조합만 받고 나머진 400(조용한 무시
 * 금지) — 이 라우트는 그대로 통과시키기만 한다(검증 재구현 없음, BE가 SSOT). */
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    const _r = await proxyToFastapiWithParams(request, '/api/v2/stories/[id]/references', { id });
    if (!_r.ok) return _r;
    const beJson = await _r.json() as Record<string, unknown>;
    return apiSuccess(beJson, undefined, _r.status);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
