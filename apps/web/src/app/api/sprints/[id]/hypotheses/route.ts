import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/sprints/:id/hypotheses — E-SPRINT-LOOP retro sprint-close cockpit(1b9f4ecb) §5 소스.
// HypothesisSprintLink 집계(BE story a4acc4d0, 디디 병행) 미착지 구간엔 BE가 404를 그대로 반환 —
// 소비부(SprintCloseCockpit)가 non-2xx를 빈 배열로 흡수해 렌더(nullable graceful, 크래시 0).
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapi(request, `/api/v2/sprints/${id}/hypotheses`);
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
