import { MemoService } from '@/services/memo';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createMemoRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();

    const dbClient = undefined;
    const repo = await createMemoRepository(dbClient);
    const service = new MemoService(repo, dbClient);
    const memo = await service.resolve(id, me.id);
    return apiSuccess(memo);
  } catch (err: unknown) {
    return handleApiError(err);
  }
}
