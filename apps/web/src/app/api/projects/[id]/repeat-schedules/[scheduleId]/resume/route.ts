import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * story c7abdf42 — «재개» 프록시. BE `PATCH /api/v2/projects/{id}/repeat-schedules/
 * {scheduleId}/resume` — paused→active, failure_count 0, pause_reason 클리어.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/projects/[id]/repeat-schedules/[scheduleId]/resume', { id, scheduleId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
