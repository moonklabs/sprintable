import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2319 — 이 라우트 자체가 없었다(GET/POST만 있는 형제 route.ts의 messages/route.ts와
// 달리 [message_id] 하위 폴더가 아예 없었다). DELETE의 핸들러 「받는 쪽」이 이것.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string; message_id: string }> },
): Promise<Response> {
  const { conversation_id, message_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/messages/${message_id}`);
}
