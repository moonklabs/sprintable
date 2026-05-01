import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 초대 목록 */
export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/invitations');
}

/** POST — 초대 생성 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/invitations');
}
