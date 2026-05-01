import { apiError } from '@/lib/api-response';

/** POST /api/auth/2fa/disable — TOTP 비활성화 (C-S3에서 구현 예정) */
export async function POST() {
  return apiSuccess({ ok: true, skipped: true });
}
