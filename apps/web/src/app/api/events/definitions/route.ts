import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2637 — GET /api/v2/events/definitions(#2634) 프록시. 카탈로그 전체(block_template
// 포함)를 응답한다 — FE는 event_key로 챗 메시지의 block_template을 조회하는 데 쓴다.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/definitions');
}
