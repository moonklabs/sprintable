import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ thread_id: string }> },
): Promise<Response> {
  const { thread_id } = await params;
  return proxyToFastapi(request, `/api/v2/chats/${thread_id}/messages`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ thread_id: string }> },
): Promise<Response> {
  const { thread_id } = await params;
  return proxyToFastapi(request, `/api/v2/chats/${thread_id}/messages`);
}
