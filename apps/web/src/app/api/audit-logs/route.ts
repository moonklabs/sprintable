import { ApiErrors } from '@/lib/api-response';

// GET /api/audit-logs — not supported in OSS mode
export async function GET() {
  return ApiErrors.notFound('Not supported in OSS mode');
}
