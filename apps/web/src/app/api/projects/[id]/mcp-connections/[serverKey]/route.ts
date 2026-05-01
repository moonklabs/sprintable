import { apiError, apiSuccess } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string; serverKey: string }> };

export async function PUT(_request: Request, _ctx: RouteParams) {
  return apiSuccess({ ok: true, skipped: true });
}

export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiSuccess({ ok: true, skipped: true });
}
