import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST — 초대 수락 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/invitations/accept');
}
