import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; scheduleId: string }> };

/**
 * story c7abdf42 — «지금 한 회차» 프록시. BE `POST /api/v2/projects/{id}/repeat-schedules/
 * {scheduleId}/run-now` — 스케줄러 tick과 같은 코드 경로(_run_one_schedule_cycle). 409 =
 * 동시 tick과 경합 중(FOR UPDATE NOWAIT) → 그대로 통과, FE가 재시도 문구로.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id, scheduleId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/projects/[id]/repeat-schedules/[scheduleId]/run-now', { id, scheduleId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
