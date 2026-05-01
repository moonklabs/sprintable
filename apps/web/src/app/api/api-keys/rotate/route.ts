import { proxyToFastapi } from '@/lib/fastapi-proxy';

/**
 * POST /api/api-keys/rotate
 * 새 API Key 발급 + 기존 키 revoked_at 설정 (원자적 교체)
 * Body: { api_key_id: string }
 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/api-keys/rotate');
}
