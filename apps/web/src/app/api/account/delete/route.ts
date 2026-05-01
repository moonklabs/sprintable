import { apiError, apiSuccess } from '@/lib/api-response';

/** POST — 계정 탈퇴 (OSS 미지원) */
export async function POST() {
  return apiSuccess({ ok: true, skipped: true });
}
