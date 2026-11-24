import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 4977 (B3-2b) — the person deletes their own history of one chat room: DELETE /api/v2/desktop/records?conversation_id[&record_id] → {deleted}. No phone is needed on the server's side (the
// history is theirs to remove even when every phone is gone). The query is closed HERE: only the two agreed words go on, each in its shape; anything else is a 422 that calls nothing.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECORD_ID = /^[0-9A-Za-z_-]{1,128}$/;

export async function DELETE(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  if (['conversation_id', 'record_id'].some((k) => q.getAll(k).length > 1)) return Response.json({ error: { code: 'bad_request' } }, { status: 422 }); // a word given twice is an ambiguous ask
  const room = q.get('conversation_id');
  const record = q.get('record_id');
  if (!room || !UUID.test(room) || (record !== null && !RECORD_ID.test(record))) return Response.json({ error: { code: 'bad_request' } }, { status: 422 });
  const url = new URL(request.url);
  url.search = '';
  url.searchParams.set('conversation_id', room);
  if (record !== null) url.searchParams.set('record_id', record);
  const res = await proxyToFastapi(new Request(url.toString(), { method: 'DELETE', headers: request.headers, signal: request.signal }), '/api/v2/desktop/records');
  const out = new Headers(res.headers);
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
