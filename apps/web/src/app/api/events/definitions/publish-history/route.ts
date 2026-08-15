import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2665 — GET /api/v2/events/definitions/publish-history(#3087, 디디) 프록시.
// query: definition_key(필수)·limit(기본20·최대200). 응답=배열(신규 로그 테이블 없이
// conversation_messages SSOT 재사용), 최신순 — raw passthrough.
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/events/definitions/publish-history');
}
