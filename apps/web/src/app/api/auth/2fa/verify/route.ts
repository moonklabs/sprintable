import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

/** POST /api/auth/2fa/verify — OTP 검증 → factor 활성화 (enabled=true) */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', '2FA is not supported in OSS mode.', 501);
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return ApiErrors.unauthorized();

    const { factor_id, code } = await request.json() as { factor_id: string; code: string };
    if (!factor_id || !code) return apiError('BAD_REQUEST', 'factor_id and code are required', 400);

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor_id });
    if (challengeError) return apiError('MFA_ERROR', challengeError.message, 400);

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: factor_id,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) return apiError('INVALID_OTP', 'Invalid or expired OTP code', 400);

    return apiSuccess({ ok: true, enabled: true });
  } catch (err: unknown) { return handleApiError(err); }
}
