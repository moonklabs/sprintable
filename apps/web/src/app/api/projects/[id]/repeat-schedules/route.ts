import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * story c7abdf42 — 반복 스케줄 목록 프록시. BE `GET /api/v2/projects/{id}/repeat-schedules`
 * (project owner 또는 org owner/admin만, 403은 BE가 강제 — 이 라우트는 그대로 통과).
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/projects/[id]/repeat-schedules', { id });
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
