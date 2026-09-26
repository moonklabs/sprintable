import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const { token } = await params;
  // Backend: POST /api/v2/invites/accept with body {token} (not path param)
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  const syntheticRequest = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token }),
  });
  const _r = await proxyToFastapi(syntheticRequest, '/api/v2/invites/accept', {
    // story #4320(까디르 QA ③) — 초대 토큰을 소비해 가입 · 합류한다(예전엔 합성 Request라 우연히 취소가 안 넘어갔다 — 이제 명시) — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
    timeLimitOnly: true,
  });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
