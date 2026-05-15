import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversation_id: string }> },
): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}/participants`);
}
