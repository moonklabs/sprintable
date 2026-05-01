import { apiSuccess, apiError } from '@/lib/api-response';

export async function GET() {
  return apiSuccess([]);
}

export async function PUT() {
  return apiSuccess({ ok: true, skipped: true });
}
