import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 초대 목록 */
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/invitations');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}

/** POST — 초대 생성 */
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/invitations');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
