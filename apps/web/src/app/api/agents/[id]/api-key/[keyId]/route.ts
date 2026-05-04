import { handleApiError } from '@/lib/api-error';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { getAuthContext } from '@/lib/auth-helpers';
import { isOssMode, createAgentApiKeyRepository } from '@/lib/storage/factory';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; keyId: string }> };

/** DELETE /api/agents/[id]/api-key/[keyId] — API Key revoke */
export async function DELETE(request: Request, { params }: RouteParams) {
  if (isOssMode()) {
    try {
      const { keyId } = await params;
      const repo = await createAgentApiKeyRepository();
      await repo.revoke(keyId);
      return apiSuccess({ message: 'API key revoked' });
    } catch (err: unknown) { return handleApiError(err); }
  }
  try {
    const { id, keyId } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    const _r = await proxyToFastapi(request, `/api/v2/agents/${id}/api-keys/${keyId}`);
    if (!_r.ok) return _r;
    return apiSuccess(await _r.json());
  } catch (err: unknown) { return handleApiError(err); }
}
