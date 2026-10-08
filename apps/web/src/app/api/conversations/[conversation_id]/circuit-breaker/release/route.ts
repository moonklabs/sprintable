import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4631 C — POST /api/v2/conversations/{id}/circuit-breaker/release proxy: [차단 해제] on the conversation's flood-block banner.
// body {reason?: string} · a human org owner/admin only (anyone else 403) · idempotent ({released: false} when already closed).
// BE returns raw `{conversation_id, released}` → pass-through.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/circuit-breaker/release`);
}
