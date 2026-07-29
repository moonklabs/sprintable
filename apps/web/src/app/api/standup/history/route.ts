

import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors, type ApiMeta } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/standup/history?project_id=X[&limit=N&cursor=C]
export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // story #2248: '/history'가 빠져 있어 list_standups(일반 목록, 오늘의 스탠드업 화면과
    // 공유하는 엔드포인트)를 부르고 있었다 — 이력 전용 규약A 엔드포인트(list_standup_history,
    // #2231 정본 규약A + created_at DESC 정렬 이미 적용)로 정정.
    const _r = await proxyToFastapi(request, '/api/v2/standups/history');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    // story #2248: BE가 {data,meta}(#2231 규약 A)를 낸다 — 그대로 apiSuccess(json)에 넘기면
    // 통째로 다시 data 필드에 얹혀 이중포장된다(stories/[id]/comments route.ts와 동일 처방).
    const beJson = await _r.json() as { data?: unknown; meta?: ApiMeta };
    return apiSuccess(beJson.data ?? beJson, beJson.meta);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
