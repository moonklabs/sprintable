import { apiError } from '@/lib/api-response';

export async function GET() {
  return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
}

export async function PUT() {
  return apiError('NOT_AVAILABLE', 'Not available in OSS mode.', 503);
}
