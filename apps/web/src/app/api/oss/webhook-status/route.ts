import { isOssMode } from '@/lib/storage/factory';
import { apiSuccess, apiError } from '@/lib/api-response';

export async function GET() {
  if (!isOssMode()) {
    return apiError('NOT_AVAILABLE', 'Only available in OSS mode', 403);
  }
  const connected = !!process.env['GITHUB_WEBHOOK_SECRET'];
  return apiSuccess({ connected });
}
