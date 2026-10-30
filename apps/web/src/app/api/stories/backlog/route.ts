import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getOrgProjectAuthContext } from '@/lib/auth-helpers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    const me = await getOrgProjectAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);

    // story #4833 — status를 안 주면 «스프린트에 안 든 것 중 끝나지 않은 장»이다(예전엔 status=backlog를 박아, 진행 중으로 바꾼 장이
    // 스프린트 패널 목록에서 사라져 스프린트에 못 넣었다). status를 주면 예전 그대로 그 상태만 본다.
    const url = new URL(request.url);
    if (!url.searchParams.get('status')) {
      url.searchParams.set('no_sprint', 'true');
      if (!url.searchParams.get('exclude_status')) url.searchParams.set('exclude_status', 'done');
    }
    const modified = new Request(url.toString(), request);
    const _r = await proxyToFastapi(modified, '/api/v2/stories');
    if (!_r.ok) return _r;
    const data = await _r.json();

    // story #2190 — BE는 커서 신호를 응답 헤더로만 낸다(X-Total-Count/X-Next-Cursor; status를 준 board 분기와 story #4833의
    // no_sprint 분기 둘 다). 이 값을 meta로 옮기지 않으면
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
      // story #3761 — `total` 은퇴, 정본 `totalCount`(goals/tasks 관례) — 헤더 없으면
      // 키 생략이 아니라 `totalCount: null`로 «모른다»를 명시한다.
      totalCount: totalHeader !== null ? Number(totalHeader) : null,
    });
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
