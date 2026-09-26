import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/2fa/verify — TOTP 검증 + 활성화 (FastAPI) */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError as NextResponse;
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const { code } = await request.json() as { code: string };
    if (!code) return apiError('BAD_REQUEST', 'code is required', 400);

    const res = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/totp/verify`, {
      // story #4320(까디르 QA ③) — TOTP 코드를 소비해 2FA를 켠다 — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
      timeLimitOnly: true,
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
