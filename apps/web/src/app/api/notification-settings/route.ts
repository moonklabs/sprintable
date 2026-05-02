import { handleApiError } from '@/lib/api-error';
import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: Request) {
  try {
    const res = await proxyToFastapi(request, '/api/v2/notification-settings');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}

export async function PUT(request: Request) {
  try {
    const res = await proxyToFastapi(request, '/api/v2/notification-settings');
    if (!res.ok) return res;
    const data: unknown = await res.json();
    return apiSuccess(data);
  } catch (err: unknown) { return handleApiError(err); }
}
