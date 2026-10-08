import { cookies } from 'next/headers';
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { SP_RT_COOKIE } from '@/lib/db/server';

// story #4533 — GET /api/v2/remote-devices proxy: my phones and the computers each is paired with (/desktop «원격 기기»).
export async function GET(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices');
}

// story #4532 — a phone registers its key (§10 ①: {label, public_key}) — only from inside the phone app (the key comes from its
// shell; a browser has none, so its pages never call this).
// story #4629 (PO 09:02Z: A2): this session's refresh token rides along, so [이 폰 빼기] can end that phone's own login later
// (the backend finds the row by its hash and keeps the id only — the switch-org way, #4400). Whatever the caller put in the body
// under that name is replaced by the cookie's value (or dropped when there is none): the phone never names a session.
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return proxyToFastapi(request, '/api/v2/remote-devices');
  const { refresh_token: _caller, ...rest } = body;
  const refreshToken = (await cookies()).get(SP_RT_COOKIE)?.value;
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const forwarded = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(refreshToken ? { ...rest, refresh_token: refreshToken } : rest),
  });
  return proxyToFastapi(forwarded, '/api/v2/remote-devices');
}
