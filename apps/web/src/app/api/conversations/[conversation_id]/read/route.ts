import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// POST /api/v2/conversations/{id}/read 프록시 — story #1976 mark-read(GREATEST 래칫·멱등).
// body {up_to?: ISO datetime} → caller participant.last_read_at 갱신 + conversation.read SSE
// 본인 타 커넥션 전파. BE가 raw {conversation_id, member_id, last_read_at, unread_count}를
// 반환하므로 proxyToFastapi 패스스루(소비부 raw, mute route와 동형).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/read`);
}
