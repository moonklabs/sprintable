import { apiSuccess } from '@/lib/api-response';

/** GET /api/usage — OSS 모드에서는 빈 배열 반환 */
export async function GET() {
  return apiSuccess([]);
}
