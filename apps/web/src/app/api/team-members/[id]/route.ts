import { apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'Member management is not supported in OSS mode.', 501);
}

export async function PATCH(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'Member management is not supported in OSS mode.', 501);
}
