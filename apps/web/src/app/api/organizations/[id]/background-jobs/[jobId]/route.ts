import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

type RouteParams = { params: Promise<{ id: string; jobId: string }> };

// story #4336 PR2 — 공용 작업 상태 보기(영상 확정 등 요청 한도를 넘을 수 있는 일). 백엔드
// backend/app/routers/background_jobs.py::get_background_job으로 그대로 위임.
export async function GET(request: Request, { params }: RouteParams) {
  const { id, jobId } = await params;
  const _r = await proxyToFastapiWithParams(
    request,
    '/api/v2/organizations/[id]/background-jobs/[jobId]',
    { id, jobId },
    { timeoutMs: LONG_ROUTES.backgroundJobStatus.bffMs },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json(), undefined, _r.status);
}
