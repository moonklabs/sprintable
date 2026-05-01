import { apiSuccess, apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });

  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  // SaaS overlay에서 처리 — OSS에서 미지원
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}
