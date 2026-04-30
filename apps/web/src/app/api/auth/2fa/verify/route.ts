import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { getServerSession } from '@/lib/supabase/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { NextResponse } from 'next/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/2fa/verify — TOTP 검증 + 활성화 (FastAPI) */
export async function POST(request: Request) {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', '2FA is not supported in OSS mode.', 501);
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError as NextResponse;
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const { code } = await request.json() as { code: string };
    if (!code) return apiError('BAD_REQUEST', 'code is required', 400);

    const res = await fetch(`${FASTAPI_URL()}/api/v2/auth/totp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ code }),
    });
    const json = await res.json() as { data?: { totp_enabled: boolean }; error?: { code: string; message: string } };
    if (!res.ok || !json.data) return apiError(json.error?.code ?? 'INVALID_OTP', json.error?.message ?? 'Invalid OTP code', res.status);

    return apiSuccess({ ok: true, enabled: json.data.totp_enabled });
  } catch (err: unknown) { return handleApiError(err); }
}
