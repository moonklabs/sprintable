import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// 1aeecdde P2: GET /api/v2/conversations/{id}/working 프록시 — 지금 답장 생성 중(working) member 목록.
// 디디 P2 BE(#1353 chat_presence·in-memory ephemeral) 폴링. FE는 이 결과로 "...is typing"/working ring 렌더.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/working`);
}
