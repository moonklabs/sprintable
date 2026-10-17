import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4714 — GET /api/v2/desktop/startable?phone_key_id=… proxy (contract 02d2cf71 §14 ④ · v1.18): the computers THIS phone's key is paired
// with, and on each the agents and the projects that have a folder there — ids and names only, never a path. The web only looks.
// Only a bare key id goes on (Kadir 5140 lens): any other query is dropped, a key id that is not a UUID is refused here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get('phone_key_id');
  if (key === null || !UUID.test(key)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('phone_key_id', key);
  const headers = new Headers(request.headers);
  return proxyToFastapi(new Request(url.toString(), { method: 'GET', headers, signal: request.signal }), '/api/v2/desktop/startable'); // the caller's abort signal still reaches the upstream call
}
