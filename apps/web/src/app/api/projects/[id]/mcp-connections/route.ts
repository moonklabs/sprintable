import { handleApiError } from '@/lib/api-error';
import { apiSuccess, apiError } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    return apiSuccess({ project_id: id, connections: [] });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(_request: Request, _ctx: RouteParams) {
  return apiError('NOT_IMPLEMENTED', 'MCP connection management is not supported in OSS mode.', 501);
}
