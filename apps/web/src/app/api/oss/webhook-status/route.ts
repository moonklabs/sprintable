import { apiError } from '@/lib/api-response';

export async function GET() {
  return apiError('NOT_AVAILABLE', 'Only available in OSS mode', 403);
}
