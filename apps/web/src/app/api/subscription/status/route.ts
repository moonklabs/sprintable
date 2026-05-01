import { apiSuccess } from '@/lib/api-response';

/** GET /api/subscription/status — OSS 모드에서는 항상 active */
export async function GET() {
  return apiSuccess({ status: 'active', grace_until: null });
}
