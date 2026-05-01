import { parseBody, createDocCommentSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { createDocRepository } from '@/lib/storage/factory';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient);
    return apiSuccess(await service.getComments(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const dbClient = undefined;
    const parsed = await parseBody(request, createDocCommentSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository(dbClient);
    const service = new DocsService(repo, dbClient);
    const comment = await service.addComment({ doc_id: id, content: body.content, created_by: me.id });

    return apiSuccess(comment, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
