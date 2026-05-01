import { apiSuccess, apiError } from '@/lib/api-response';

/** GET — 초대 목록 (OSS 미지원) */
export async function GET(_request?: Request) {
  return apiSuccess([]);
}

/** POST — 초대 생성 (OSS 미지원) */
export async function POST(_request: Request) {
  return apiSuccess({ ok: true, skipped: true });
}
