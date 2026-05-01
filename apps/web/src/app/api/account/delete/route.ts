import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST — 계정 탈퇴 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/account/delete');
}
