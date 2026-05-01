import { apiSuccess, apiError } from '@/lib/api-response';

export async function GET() {
  return apiSuccess([]);
}

export async function PUT() {
  return apiError('NOT_IMPLEMENTED', 'Notification settings are not supported in OSS mode.', 501);
}
