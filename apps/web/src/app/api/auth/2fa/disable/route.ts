import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { NextResponse } from 'next/server';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/2fa/disable — TOTP 비활성화 (FastAPI)
 *
 * story #3247 — 이전엔 `/api/v2/auth/2fa/disable`(존재한 적 없는 경로)를 그대로 호출해
 * 항상 404였다. setup/verify와 동일하게 BE는 totp 축 네이밍이므로 `/api/v2/auth/totp/disable`
 * 로 정정(FE 바깥 경로 `2fa/*`는 setup·verify와 형제 유지, BE 프록시 타깃만 totp로 통일).
 */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError as NextResponse;
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const { code, password } = await request.json() as { code?: string; password?: string };
    if (!code && !password) return apiError('BAD_REQUEST', 'code or password is required', 400);

    const res = await fetch(`${FASTAPI_URL()}/api/v2/auth/totp/disable`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ code, password }),
    });
    const json = await res.json() as { data?: { totp_enabled: boolean }; error?: { code: string; message: string } };
    if (!res.ok || !json.data) return apiError(json.error?.code ?? 'MFA_ERROR', json.error?.message ?? 'Failed to disable TOTP', res.status);

    return apiSuccess({ ok: true, enabled: json.data.totp_enabled });
  } catch (err: unknown) { return handleApiError(err); }
}
