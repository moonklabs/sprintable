import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// E-ARCH 1단계(story #2078) — SSE/LISTEN 전용 realtime-gateway(REALTIME_URL)로 이 라우트만
// 전환한다. REALTIME_URL이 설정돼 있으면 그쪽으로, 없으면 기존 FASTAPI_URL로 폴백 —
// "되돌리면 원복"(env 값을 비우면 코드 변경·재배포 없이 즉시 원래 경로로 복귀).
const EVENT_STREAM_UPSTREAM_URL = () => process.env['REALTIME_URL'] || FASTAPI_URL();

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

  const upstreamUrl = new URL(`${EVENT_STREAM_UPSTREAM_URL()}/api/v2/events/stream`);
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
