import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 시나리오 목록 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** POST — 시나리오 생성 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** PATCH — 시나리오 수정 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** DELETE — 시나리오 삭제 (default 불가) */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  const _r = await proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
