import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4548 — POST /api/v2/desktop/device-token-codes/peek 프록시(사람 세션 · 그 기기 조직 owner/admin). body = {code}.
// 코드는 본문으로만 — 어떤 경로에도 싣지 않는다(까디르 4825). 판단(권한 · 만료 · 끊김)은 BE가 한다.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/desktop/device-token-codes/peek');
}
