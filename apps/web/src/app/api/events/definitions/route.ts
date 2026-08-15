import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2637 — GET /api/v2/events/definitions(#2634) 프록시. 카탈로그 전체(block_template
// 포함)를 응답한다 — FE는 event_key로 챗 메시지의 block_template을 조회하는 데 쓴다.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/definitions');
}

// story #2664 — org 커스텀 정의 생성. body = {key, payload_schema, routing, block_template?,
// action_auth?}. 네임스페이스(org.{slug}.*) 검증·JSON Schema 검증은 BE가 전부 수행(400/409
// 그대로 통과) — raw passthrough.
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/definitions');
}
