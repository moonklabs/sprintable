import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// PATCH /api/v2/conversations/{id}/mute 프록시 — per-대화 알림 mute/unmute (270c87e6).
// body {muted: boolean} → caller participant의 muted_at set/null. 비참여자=403.
// BE는 raw `{conversation_id, muted}`를 반환하므로 proxyToFastapi 패스스루(소비부 raw).
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/mute`);
}
