import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError, ApiErrors } from '@/lib/api-response';
import { getServerSession } from '@/lib/db/server';
import { verifyCsrfOrigin } from '@/lib/auth/csrf';
import { NextResponse } from 'next/server';
import { backendFetch } from '@/lib/backend-fetch';

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

/** POST /api/auth/2fa/setup — TOTP secret 생성 (FastAPI) */
export async function POST(request: Request) {
  const csrfError = verifyCsrfOrigin(request);
  if (csrfError) return csrfError as NextResponse;
  try {
    const session = await getServerSession();
    if (!session) return ApiErrors.unauthorized();

    const res = await backendFetch(`${FASTAPI_URL()}/api/v2/auth/totp/setup`, {
      // story #4320(까디르 QA ③) — 2FA 비밀을 새로 낸다 — 브라우저가 끊어도 끝까지 간다 · 시간 제한만.
      timeLimitOnly: true,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
    });
    const json = await res.json() as { data?: { totp_secret: string; provisioning_uri: string }; error?: { code: string; message: string } };
    if (!res.ok || !json.data) return apiError(json.error?.code ?? 'MFA_ERROR', json.error?.message ?? 'TOTP setup failed', res.status);

    return apiSuccess({ secret: json.data.totp_secret, uri: json.data.provisioning_uri });
  } catch (err: unknown) { return handleApiError(err); }
}
