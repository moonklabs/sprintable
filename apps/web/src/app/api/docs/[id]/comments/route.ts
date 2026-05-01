import { parseBody, createDocCommentSchema } from '@sprintable/shared';
import { DocsService } from '@/services/docs';
import { handleApiError } from '@/lib/api-error';
import { getAuthContext } from '@/lib/auth-helpers';
import { apiSuccess, ApiErrors } from '@/lib/api-response';
import { notifyDocCommentMentions } from '@/services/doc-comment-notifications';
import { createDocRepository } from '@/lib/storage/factory';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = undefined;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const repo = await createDocRepository();
    const service = new DocsService(repo);
    return apiSuccess(await service.getComments(id));
  } catch (err: unknown) { return handleApiError(err); }
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const me = await getAuthContext(request);
    if (!me) return ApiErrors.unauthorized();
    if (me.rateLimitExceeded) return ApiErrors.tooManyRequests(me.rateLimitRemaining, me.rateLimitResetAt);
    const parsed = await parseBody(request, createDocCommentSchema); if (!parsed.success) return parsed.response; const body = parsed.data;
    const repo = await createDocRepository();
    const service = new DocsService(repo);
    const comment = await service.addComment({ doc_id: id, content: body.content, created_by: me.id });

    try {
      await notifyDocCommentMentions({
        sourceSupabase: supabase,
        adminSupabase: (await (await import('@/lib/supabase/admin')).createSupabaseAdminClient()),
        docId: id,
        commentId: comment.id as string,
        content: comment.content as string,
        authorId: me.id,
      });
    } catch (notifyError) {
      console.error('[Docs] failed to create comment mention notifications', notifyError);
    }

    return apiSuccess(comment, undefined, 201);
  } catch (err: unknown) { return handleApiError(err); }
}
