import { apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiSuccess({ ok: true, skipped: true });
}

export async function PATCH(_request: Request, _ctx: RouteParams) {
  return apiSuccess({ ok: true, skipped: true });
}
