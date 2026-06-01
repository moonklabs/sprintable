import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(request: NextRequest): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const memberId = searchParams.get('member_id');
  const lastEventId = searchParams.get('last_event_id') ?? request.headers.get('Last-Event-ID');

  const upstreamUrl = new URL(`${FASTAPI_URL()}/api/v2/events/stream`);
  if (memberId) upstreamUrl.searchParams.set('member_id', memberId);
  if (lastEventId) upstreamUrl.searchParams.set('last_event_id', lastEventId);

  const upstreamHeaders: Record<string, string> = { Authorization: `Bearer ${session.access_token}` };
  if (lastEventId) upstreamHeaders['Last-Event-ID'] = lastEventId;

  const upstream = await fetch(upstreamUrl.toString(), { headers: upstreamHeaders });

  if (!upstream.ok) {
    return NextResponse.json(
      { error: { code: 'UPSTREAM_ERROR', message: `HTTP ${upstream.status}` } },
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
