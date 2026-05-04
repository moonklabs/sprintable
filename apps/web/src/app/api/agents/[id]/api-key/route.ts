import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createAgentApiKeyRepository } from '@/lib/storage/factory';
import { generateApiKey } from '@/lib/auth-api-key';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/agents/[id]/api-key — API Key 목록 조회 */
export async function GET(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id: teamMemberId } = await params;
      const repo = await createAgentApiKeyRepository();
      return apiSuccess(await repo.list(teamMemberId));
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/api-keys`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}

/** POST /api/agents/[id]/api-key — API Key 발급 */
export async function POST(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { id: teamMemberId } = await params;
      const body = await request.json().catch(() => ({})) as { expires_at?: string; scope?: string[] };
      const { apiKey, keyPrefix, keyHash } = generateApiKey();
      const defaultExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      const expiresAt = body.expires_at ?? defaultExpiry;
      const scope = body.scope ?? ['read', 'write'];
      const repo = await createAgentApiKeyRepository();
      const row = await repo.create({ teamMemberId, keyPrefix, keyHash, expiresAt, scope });
      return apiSuccess({ ...row, api_key: apiKey }, undefined, 201);
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/api-keys`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json(), undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}

/** DELETE /api/agents/[id]/api-key?key_id={key_id} — API Key 폐기 */
export async function DELETE(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { searchParams } = new URL(request.url);
      const keyId = searchParams.get('key_id');
      if (!keyId) return ApiErrors.badRequest('key_id required');
      const repo = await createAgentApiKeyRepository();
      await repo.revoke(keyId);
      return apiSuccess({ ok: true });
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const keyId = searchParams.get('key_id');
    if (!keyId) return ApiErrors.badRequest('key_id required');
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/api-keys/${keyId}`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
