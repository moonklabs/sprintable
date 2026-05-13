import { NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(): Promise<Response> {
  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const upstream = await fetch(`${FASTAPI_URL()}/api/v2/events/stream`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });

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
