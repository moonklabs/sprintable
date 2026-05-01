import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** POST — 메모를 스토리로 전환 */
export async function POST(request: Request) {
  return proxyToFastapi(request, '/api/v2/memos/convert');
}
