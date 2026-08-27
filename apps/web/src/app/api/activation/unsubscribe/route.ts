import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #3159 — 리마인드 메일 링크 클릭은 pre-auth(수신자 브라우저에 세션이 없을 수 있음).
// 토큰 자체가 인가이므로 invites/[token]과 동형으로 public: true.
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/activation/unsubscribe', { public: true });
  if (!_r.ok) return _r;
  if (_r.status === 204) return apiSuccess({ ok: true });
  return apiSuccess(await _r.json());
}
