import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4548 — POST /api/v2/desktop/device-token-codes/confirm 프록시(사람 세션 · 그 기기 조직 owner/admin). body = {code}.
// 코드는 본문으로만(까디르 4825). 같은 사람이 다시 눌러도 200 — 판단은 BE.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/device-token-codes/confirm');
}
