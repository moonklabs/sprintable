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

  // story #2183 — signal이 없으면 이 요청(클라 연결 종료·프론트 자신의 Cloud Run 요청이 60초로
  // 잘리는 것 포함)이 끝나도 upstream(realtime-gateway) 커넥션은 안 끊긴다. 프론트가 60초마다
  // 클라 쪽만 끊고 재연결하는 사이클이라, 재연결 1회마다 좀비 upstream 커넥션이 하나씩 쌓여
  // realtime 타임아웃(3600s) 상한까지 살아있는다 — 탭 1개당 누적 최대 ~60개. request.signal을
  // 넘겨 다운스트림이 끝나면 upstream fetch도 즉시 abort되게 한다.
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), { headers: upstreamHeaders, signal: request.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // 클라가 이미 연결을 끊은 뒤라 응답을 볼 대상이 없다 — 조용히 빈 응답으로 정리.
      return new Response(null, { status: 499 });
    }
    throw err;
  }

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
