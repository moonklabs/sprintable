import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #2192 — BE(/api/v2/event-notifications)는 limit/offset을 이미 정직히 지원하지만
// (backend/app/routers/event_notifications.py: limit ge=1,le=100 · offset ge=0) 응답이
// 순수 배열이라 "더 있다"는 신호가 전혀 없었다 — 그래서 이 프록시는 그동안 raw 배열을
// 그대로 통과시켰을 뿐 meta를 만들지 않았다(notification-bell.tsx가 limit=30 고정으로만
// 불러 31번째부터는 조용히 잘림). BE가 limit을 초과해 주지 않으므로(over-fetch 없음)
// 정확히 limit만큼 돌아왔을 때만 다음 페이지가 있을 수 있다고 본다(#2190과 동일 판단).
export async function GET(request: Request): Promise<Response> {
  const _r = await proxyToFastapi(request, '/api/v2/event-notifications');
  if (!_r.ok) return _r;
  const data = await _r.json();

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get('limit')) || 20; // BE 기본값과 동일
  const requestedOffset = Number(url.searchParams.get('offset')) || 0;
  const hasMore = Array.isArray(data) && data.length === requestedLimit;

  return apiSuccess(data, { limit: requestedLimit, offset: requestedOffset, hasMore });
}
