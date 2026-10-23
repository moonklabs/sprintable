import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** GET — what the account deletion would do to the person's organizations (story #4752): `closing` (they close with the account) and `blocked` (with the reason). Read only. */
export async function GET(request: Request) {
  const _r = await proxyToFastapi(request, '/api/v2/account/delete-preview');
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
