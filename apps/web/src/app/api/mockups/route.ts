import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — 목업 목록 (페이지네이션) */
export async function GET(request: Request) {
  return proxyToFastapi(request, '/api/v2/mockups');
}

/** POST — 목업 생성 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/mockups');
}
