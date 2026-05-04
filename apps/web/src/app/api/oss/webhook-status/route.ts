import { apiSuccess } from '@/lib/api-response';

export async function GET() {
  const connected = !!process.env['GITHUB_WEBHOOK_SECRET'];
  return apiSuccess({ connected });
}
