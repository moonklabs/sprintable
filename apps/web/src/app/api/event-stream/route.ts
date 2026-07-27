import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from '@/lib/db/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

// E-ARCH 1단계(story #2078) — SSE/LISTEN 전용 realtime-gateway(REALTIME_URL)로 이 라우트만
// 전환한다. REALTIME_URL이 설정돼 있으면 그쪽으로, 없으면 기존 FASTAPI_URL로 폴백 —
// "되돌리면 원복"(env 값을 비우면 코드 변경·재배포 없이 즉시 원래 경로로 복귀).
const EVENT_STREAM_UPSTREAM_URL = () => process.env['REALTIME_URL'] || FASTAPI_URL();

// story #2183 후속(2026-07-25) — request.signal 단독으로는 안 잡힌다는 것이 배포 후 라이브
// 실측으로 확認됐다(착지 前 점유 n=300 전부 정확히 3601.0s → 착지 後에도 617~658s, ~60s가
// 나왔어야 했다). Cloud Run이 다운스트림(이 라우트 자신에 대한 요청)을 강제로 끊어도 Next
// 런타임이 그 종료를 항상 request.signal로 전파해 주지는 않는 것으로 판정 — "생명 판정 신호는
// 판정 대상이 스스로 갱신할 수 없는 것이어야 한다"(#2128과 동일 원리)에 따라 signal 대신
// wall-clock을 본체로 삼는다. request.signal 배선은 지우지 않는다(틀린 코드는 아님 — 런타임이
// 나중에 고쳐지면 그때부터 더 빨리 반응한다) — 이 라우트 자신에 대한 다운스트림 요청이 어차피
// 프론트 Cloud Run 서비스 자신의 timeoutSeconds(dev 확認값: 60s)로 강제 종료되므로, upstream은
// 그보다 반드시 먼저 닫혀야 한다(≡ "프록시의 upstream은 프록시 자신의 수명보다 오래 살 수
// 없다"). 55s = 60s − 5s: getServerSession()·URL 구성 등 fetch 호출 前 처리비용만큼 타이머
// 시작이 다운스트림 요청 시작보다 늦으므로 그 지연을 흡수하는 안전마진.
// ⚠️무너지는 조건: 프론트 Cloud Run 서비스의 timeoutSeconds가 60s가 아니게 되면 이 상수도
// 같이 바뀌어야 한다 — 값이 코드(여기)와 인프라 설정(Cloud Run 서비스 config) 두 곳에
// 살게 되는 것 — 단일 소스로 묶는 것은 인프라 축이라 이 스토리 스코프 밖으로 남긴다.
const UPSTREAM_HARD_TIMEOUT_MS = 55_000;

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

  // story #2183 — signal이 없으면 이 요청(클라 연결 종료 포함)이 끝나도 upstream(realtime-
  // gateway) 커넥션은 안 끊긴다. request.signal을 넘겨 다운스트림이 끝나면 upstream fetch도
  // abort되게 한다 — 다만 이것만으로는 부족하다는 것이 라이브로 확認됐다(위 상수 주석 참고).
  // wall-clock 캡을 같이 걸어 본체로 삼고, signal은 부수 경로로 유지한다(#2128과 동형 2층 구조).
  const upstreamSignal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_HARD_TIMEOUT_MS)]);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), { headers: upstreamHeaders, signal: upstreamSignal });
  } catch (err) {
    // AbortError = request.signal(클라 종료) · TimeoutError = wall-clock 캡(본체) — 실측 확認됨,
    // 둘 다 "클라가 이미 없거나 이 요청의 최대 수명을 넘겼다"는 뜻이라 응답 볼 대상이 없다.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
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
