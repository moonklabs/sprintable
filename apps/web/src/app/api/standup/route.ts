
import { proxyToFastapi } from '@/lib/fastapi-proxy';
;
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { saveStandupSchema } from '@sprintable/shared';
import { getOssStandupEntryForUser, listOssStandupEntries, saveOssStandupEntry } from '@/lib/oss-standup';

// GET /api/standup?project_id=...&date=YYYY-MM-DD[&member_id=...]
export async function GET(request: Request) {
  try {
const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// POST /api/standup — supports Dual Auth; agent may pass author_id in body
export async function POST(request: Request) {
  try {
const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}

// PUT /api/standup — kept for backwards compatibility (human auth only)
export async function PUT(request: Request) {
  try {
const _r = await proxyToFastapi(request, '/api/v2/standups');
    if (!_r.ok) return _r;
    if (_r.status === 204) return apiSuccess({ ok: true });
    return apiSuccess(await _r.json())
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
