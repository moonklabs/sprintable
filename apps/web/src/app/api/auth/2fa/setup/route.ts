import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { getServerSession } from '@/lib/supabase/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/2fa/setup — TOTP secret 생성 (FastAPI) */
export async function POST() {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', '2FA is not supported in OSS mode.', 501);
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const res = await fetch(`${FASTAPI_URL()}/api/v2/auth/totp/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const json = await res.json() as { data?: { totp_secret: string; provisioning_uri: string }; error?: { code: string; message: string } };
    if (!res.ok || !json.data) return apiError(json.error?.code ?? 'MFA_ERROR', json.error?.message ?? 'TOTP setup failed', res.status);

    return apiSuccess({ secret: json.data.totp_secret, uri: json.data.provisioning_uri });
  } catch (err: unknown) { return handleApiError(err); }
}
