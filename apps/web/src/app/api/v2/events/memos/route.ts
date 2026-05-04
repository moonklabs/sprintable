import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(request: NextRequest) {
  const session = await getServerSession();
  if (!session?.access_token) {
    return NextResponse.json(
      { data: null, error: { code: 'UNAUTHORIZED', message: 'Authentication required' }, meta: null },
      { status: 401 },
    );
  }

  const { searchParams } = new URL(request.url);
  const upstream = await fetch(
    `${FASTAPI_URL()}/api/v2/events/memos?${searchParams.toString()}`,
    {
      headers: { Authorization: `Bearer ${session.access_token}` },
    },
  );

  if (!upstream.ok) {
    let errBody: { detail?: string; error?: { code?: string; message?: string } } = {};
    try { errBody = await upstream.json(); } catch { /* ignore */ }
    const message = errBody.error?.message ?? errBody.detail ?? `HTTP ${upstream.status}`;
    const code = errBody.error?.code ?? 'UPSTREAM_ERROR';
    return NextResponse.json(
      { data: null, error: { code, message }, meta: null },
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
