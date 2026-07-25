import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // FastAPI에서 status=backlog 필터로 처리
    const url = new URL(request.url);
    if (!url.searchParams.get('status')) url.searchParams.set('status', 'backlog');
    const modified = new Request(url.toString(), request);
    const _r = await proxyToFastapi(modified, '/api/v2/stories');
    if (!_r.ok) return _r;
    const data = await _r.json();

    // story #2190 — 이 경로는 status+project_id 조합이라 BE list_stories의 board 분기로 가고
    // (list_backlog/no_sprint 분기가 아니다), board 분기는 커서 페이지네이션을 지원하지만 그
    // 신호를 응답 헤더로만 낸다(X-Total-Count/X-Next-Cursor). 이 값을 meta로 옮기지 않으면
    // FE(sprints-client.tsx)의 `json.meta?.hasMore ?? false`가 구조적으로 항상 false가 되어
    // "더 보기" 버튼이 영영 안 뜬다. BE는 limit을 초과해 주지 않으므로(over-fetch 없음) 정확히
    // limit만큼 돌아왔을 때만 다음 페이지가 있을 수 있다고 본다.
    const requestedLimit = Number(url.searchParams.get('limit')) || 1000;
    const nextCursor = _r.headers.get('x-next-cursor');
    const totalHeader = _r.headers.get('x-total-count');
    const hasMore = Array.isArray(data) && data.length === requestedLimit && nextCursor !== null;

    return apiSuccess(data, {
      limit: requestedLimit,
      hasMore,
      nextCursor: hasMore ? nextCursor : null,
      ...(totalHeader !== null ? { total: Number(totalHeader) } : {}),
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
