import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

/** POST /api/auth/2fa/setup — TOTP factor 등록 시작, QR URI + secret 반환 */
export async function POST() {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', '2FA is not supported in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (error) return apiError('MFA_ERROR', error.message, 400);

    return apiSuccess({
      factor_id: data.id,
      qr_code: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  } catch (err: unknown) { return handleApiError(err); }
}
