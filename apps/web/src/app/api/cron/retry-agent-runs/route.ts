import { apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });

  const authHeader = request.headers.get('authorization');
  const headers: Record<string, string> = {};
  if (authHeader) headers['authorization'] = authHeader;

  const res = await fetch(`${FASTAPI_URL()}/api/v2/internal/cron/retry-agent-runs`, {
    method: 'GET',
    headers,
  });

  const json = await res.json().catch(() => ({}));
  return Response.json(json, { status: res.status });
}
