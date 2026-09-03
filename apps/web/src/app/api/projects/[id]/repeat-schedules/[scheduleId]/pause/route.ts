import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * story c7abdf42 — «중지» 프록시. BE `PATCH /api/v2/projects/{id}/repeat-schedules/
 * {scheduleId}/pause` — active→paused(수동 중지 사유 영속).
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/projects/[id]/repeat-schedules/[scheduleId]/pause', { id, scheduleId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
