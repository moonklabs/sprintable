import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST /api/auth/2fa/disable — TOTP 비활성화 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/auth/2fa/disable');
}
