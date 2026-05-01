import { apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string; serverKey: string }> };

export async function PUT(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'MCP connection management is not supported in OSS mode.', 501);
}

export async function DELETE(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'MCP connection management is not supported in OSS mode.', 501);
}
