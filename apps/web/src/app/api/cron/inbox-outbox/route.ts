import { apiError, apiSuccess } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';
import { InboxOutboxService } from '@/services/inbox-outbox.service';

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request: Request) {
  if (isOssMode()) return apiSuccess({ ok: true, skipped: true });

  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return apiError('UNAUTHORIZED', 'Unauthorized', 401);
  }

  try {
    // SaaS overlay에서 처리
    return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
  } catch (error) {
    return apiError(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Internal error',
      500,
    );
  }
}
