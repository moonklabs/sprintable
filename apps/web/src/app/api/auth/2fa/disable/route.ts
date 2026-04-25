import { createSupabaseServerClient } from '@/lib/supabase/server';
import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

/** POST /api/auth/2fa/disable — OTP 검증 후 TOTP factor 비활성화 */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', '2FA is not supported in OSS mode.', 501);
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { code } = await request.json() as { code: string };
    if (!code) return apiError('BAD_REQUEST', 'code is required', 400);

    // 등록된 TOTP factor 조회
    const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) return apiError('MFA_ERROR', listError.message, 400);

    const totpFactor = factors?.totp?.[0];
    if (!totpFactor) return apiError('NOT_FOUND', '2FA is not enabled', 404);

    // OTP 검증
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
    if (challengeError) return apiError('MFA_ERROR', challengeError.message, 400);

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: totpFactor.id,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) return apiError('INVALID_OTP', 'Invalid or expired OTP code', 400);

    // Unenroll
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId: totpFactor.id });
    if (unenrollError) return apiError('MFA_ERROR', unenrollError.message, 400);

    return apiSuccess({ ok: true, enabled: false });
  } catch (err: unknown) { return handleApiError(err); }
}
