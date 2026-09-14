import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/agent-runs
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

// GET /api/agent-runs?project_id=X&limit=N
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/agent-runs');
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  const data = await _r.json();

  // story #3857 — BE list_agent_runs(story #3851)가 X-Total-Count·X-Next-Cursor를
  // 내는데 이 라우트가 body만 취해 헤더를 버려 왔다(stories/backlog/route.ts #2190과
  // 동일 결함 클래스). fastapi-proxy.ts가 이미 이 두 헤더를 자기 Response에 forward하고
  // 있으므로(허용목록에 포함) 여기서 읽기만 하면 된다 — BE는 over-fetch 없이 정확히
  // limit개만 주므로(over-fetch 0) "받은 개수===요청 limit"일 때만 다음 페이지 여지.
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get('limit')) || 50; // BE Query(default=50)와 동일
  const nextCursor = _r.headers.get('x-next-cursor');
  const totalHeader = _r.headers.get('x-total-count');
  const hasMore = Array.isArray(data) && data.length === requestedLimit && nextCursor !== null;

  return apiSuccess(data, {
    limit: requestedLimit,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
    totalCount: totalHeader !== null ? Number(totalHeader) : null,
  });
}
