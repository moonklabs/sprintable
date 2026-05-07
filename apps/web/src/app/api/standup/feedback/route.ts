
import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';

export async function GET(request: Request) {
  try {
    const _r = await proxyToFastapi(request, '/api/v2/standups/feedback');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { standup_entry_id?: string; [key: string]: unknown };
    const { standup_entry_id, ...rest } = body;
    if (!standup_entry_id) {
      return new Response(JSON.stringify({ error: 'standup_entry_id required' }), { status: 400 });
    }
    const newRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(rest),
    });
    const _r = await proxyToFastapi(newRequest, `/api/v2/standups/${standup_entry_id}/feedback`);
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json());
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
