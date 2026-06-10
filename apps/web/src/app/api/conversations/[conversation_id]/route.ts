import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ conversation_id: string }> };

/** PATCH — edit a conversation (e.g. room title). Thin-proxy to the BE (EF-S2). */
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<Response> {
  const { conversation_id } = await params;
  return proxyToFastapi(request, `/api/v2/conversations/${conversation_id}`);
}
