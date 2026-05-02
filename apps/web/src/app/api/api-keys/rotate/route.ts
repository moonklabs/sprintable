import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/api-keys/rotate
 * 새 API Key 발급 + 기존 키 revoked_at 설정 (원자적 교체)
 * Body: { api_key_id: string }
 */
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/api-keys/rotate');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
