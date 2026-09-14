import { apiSuccess } from '@/lib/api-response';

import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { buildHeaderCursorPageMeta } from '@/lib/pagination';

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
  // 있으므로 여기서 읽기만 하면 된다. PO CHANGES①(2026-09-14 09:01Z) — X-Next-Cursor는
  // 페이지가 비어 있지 않으면 항상 실리므로(agent_runs.py:127 `if runs:`) 존재 자체가
  // 「더 있음」의 증거가 아니다. 판정은 pagination.ts::buildHeaderCursorPageMeta로 위임
  // (첫 페이지=X-Total-Count 정확 비교·cursor 페이지=limit-full+cursor 보수 규칙).
  const { searchParams } = new URL(request.url);
  const requestedLimit = Number(searchParams.get('limit')) || 50; // BE Query(default=50)와 동일
  const hasCursorParam = Boolean(searchParams.get('cursor'));
  const nextCursor = _r.headers.get('x-next-cursor');
  const totalHeader = _r.headers.get('x-total-count');

  return apiSuccess(data, buildHeaderCursorPageMeta({
    dataLength: Array.isArray(data) ? data.length : 0,
    requestedLimit,
    hasCursorParam,
    nextCursorHeader: nextCursor,
    totalCountHeader: totalHeader !== null ? Number(totalHeader) : null,
  }));
}
