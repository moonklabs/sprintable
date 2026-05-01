import { apiError } from '@/lib/api-response';

/** POST — 초대 수락 (OSS 미지원) */
export async function POST(_request: Request) {
  return apiSuccess({ ok: true, skipped: true });
}
