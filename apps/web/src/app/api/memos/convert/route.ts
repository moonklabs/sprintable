import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST — 메모를 스토리로 전환 */
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/memos/convert');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
