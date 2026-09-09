import { apiSuccess } from '@/lib/api-response';
import { handleApiError } from '@/lib/api-error';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// story #3722(Trust·PR2) — GET /agent-runs/{id}/tool-calls는 X-Total-Count를 준다(페드루 PO
// 追加, 2026-09-09 — #3703/#3706류 "한 페이지=전부" 오판 재발 방지). list_agent_runs
// route.ts(v1/agent-runs/route.ts)가 그 헤더를 버리는 부채와 달리, 이 신규 자리는 처음부터
// meta.totalCount로 얹는다(goals/route.ts position 모드와 동형 — Number.isFinite 가드로
// 계약 위반(NaN)도 null로 통일, "모르면 단정 안 함").
export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const _r = await proxyToFastapi(request, `/api/v2/agent-runs/${id}/tool-calls`);
    if (!_r.ok) return _r;
    const rows = (await _r.json()) as unknown[];
    const totalHeader = _r.headers.get('x-total-count');
    const parsed = totalHeader === null ? null : Number(totalHeader);
    const totalCount = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    return apiSuccess(rows, { totalCount });
  } catch (error) { return handleApiError(error); }
}
