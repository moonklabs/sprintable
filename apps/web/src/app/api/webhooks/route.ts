import { apiError } from '@/lib/api-response';
import { isOssMode } from '@/lib/storage/factory';

export async function GET() {
  if (isOssMode()) return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
  return apiError('NOT_IMPLEMENTED', 'SaaS overlay required', 501);
}

// Deprecated: use PUT /api/webhooks/config instead (supports project_id scoping)
export async function PUT() {
  return apiError('GONE', 'Use PUT /api/webhooks/config instead.', 410);
}
