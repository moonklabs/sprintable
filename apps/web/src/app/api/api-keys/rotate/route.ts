import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/api-keys/rotate
 * 새 API Key 발급 + 기존 키 revoked_at 설정 (원자적 교체)
 * Body: { api_key_id: string }
 */
export async function POST(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/api-keys/rotate', {
    // story #4320(까디르 QA ③) — API 키를 회전(옛 키 폐기 · 새 키 발급) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
  });
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
}
