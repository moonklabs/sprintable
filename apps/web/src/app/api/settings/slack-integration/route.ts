import { apiSuccess } from '@/lib/api-response';

export async function GET() {
  return apiSuccess(null);
}

export async function PUT() {
  return apiSuccess({ ok: true });
}
