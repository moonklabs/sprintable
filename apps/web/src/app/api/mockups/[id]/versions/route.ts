import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 버전 히스토리 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/versions', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** POST — 버전 복원 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/versions', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
